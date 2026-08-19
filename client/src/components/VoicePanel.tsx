import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Mic, MicOff, PhoneOff, Video, VideoOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { trpc } from "@/lib/trpc";

/**
 * A voice/video channel — the client half of ADR 0013.
 *
 * All media flows browser ↔ Cloudflare SFU; this component only ever hands
 * SDP to our own server, which proxies the Connection API and keeps
 * presence. The dance is Cloudflare's documented lifecycle exactly:
 * session from first offer → publish local tracks → poll presence → pull
 * remote tracks → answer the renegotiation the pull triggers. Presence
 * rides the same short polling the message sync uses, so joining a channel
 * needs no new transport anywhere.
 *
 * Remote tracks are mapped to people through the mid the SFU assigns at
 * pull time: pullTracks tells us which mid will carry which
 * (sessionId, trackName), and ontrack fires with that mid. Nothing is
 * guessed from ordering.
 */

const STUN: RTCConfiguration = {
  iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }],
  bundlePolicy: "max-bundle",
};

type RemoteFeed = {
  userId: number;
  username: string;
  stream: MediaStream;
  hasVideo: boolean;
};

export default function VoicePanel({
  channelId,
  channelName,
}: {
  channelId: number;
  channelName: string;
}) {
  const [joined, setJoined] = useState(false);
  const [joining, setJoining] = useState(false);
  const [muted, setMuted] = useState(false);
  const [camera, setCamera] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [feeds, setFeeds] = useState<RemoteFeed[]>([]);

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const sessionRef = useRef<string | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  /** trackName → owner, learned from presence before pulling. */
  const trackOwner = useRef(new Map<string, { userId: number; username: string }>());
  /** mid → trackName, learned from the pull response. */
  const midTrack = useRef(new Map<string, string>());
  const pulled = useRef(new Set<string>());
  const localVideoRef = useRef<HTMLVideoElement | null>(null);

  const status = trpc.voice.status.useQuery();
  const join = trpc.voice.join.useMutation();
  const publishTracks = trpc.voice.publishTracks.useMutation();
  const pullTracks = trpc.voice.pullTracks.useMutation();
  const renegotiate = trpc.voice.renegotiate.useMutation();
  const heartbeat = trpc.voice.heartbeat.useMutation();
  const leaveMutation = trpc.voice.leave.useMutation();
  const participants = trpc.voice.participants.useQuery(
    { channelId },
    { refetchInterval: 2000, enabled: joined }
  );

  const leave = useCallback(() => {
    pcRef.current?.close();
    pcRef.current = null;
    localStreamRef.current?.getTracks().forEach(t => t.stop());
    localStreamRef.current = null;
    sessionRef.current = null;
    trackOwner.current.clear();
    midTrack.current.clear();
    pulled.current.clear();
    setFeeds([]);
    setJoined(false);
    setCamera(false);
    leaveMutation.mutate({ channelId });
  }, [channelId, leaveMutation]);

  // Leaving the page is leaving the channel.
  useEffect(() => () => { if (pcRef.current) leave(); }, [leave]);

  // Liveness: without this the server sweeps us after twenty seconds.
  useEffect(() => {
    if (!joined) return;
    const t = setInterval(() => heartbeat.mutate({ channelId }), 5000);
    return () => clearInterval(t);
  }, [joined, channelId, heartbeat]);

  async function handleJoin(withCamera: boolean) {
    setJoining(true);
    setError(null);
    try {
      const media = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: withCamera,
      });
      localStreamRef.current = media;
      if (withCamera && localVideoRef.current) {
        localVideoRef.current.srcObject = media;
      }

      const pc = new RTCPeerConnection(STUN);
      pcRef.current = pc;

      pc.ontrack = event => {
        const mid = event.transceiver.mid;
        const trackName = mid ? midTrack.current.get(mid) : undefined;
        const owner = trackName ? trackOwner.current.get(trackName) : undefined;
        if (!owner) return;
        setFeeds(prev => {
          const existing = prev.find(f => f.userId === owner.userId);
          if (existing) {
            existing.stream.addTrack(event.track);
            return prev.map(f =>
              f.userId === owner.userId
                ? { ...f, hasVideo: f.hasVideo || event.track.kind === "video" }
                : f
            );
          }
          const stream = new MediaStream([event.track]);
          return [
            ...prev,
            {
              userId: owner.userId,
              username: owner.username,
              stream,
              hasVideo: event.track.kind === "video",
            },
          ];
        });
      };

      const transceivers = media
        .getTracks()
        .map(track => pc.addTransceiver(track, { direction: "sendonly" }));

      await pc.setLocalDescription(await pc.createOffer());
      const session = await join.mutateAsync({
        channelId,
        offerSdp: pc.localDescription!.sdp,
      });
      sessionRef.current = session.sessionId;
      await pc.setRemoteDescription({ type: "answer", sdp: session.answerSdp });

      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Couldn't reach the media network.")), 8000);
        pc.addEventListener("iceconnectionstatechange", () => {
          if (pc.iceConnectionState === "connected") {
            clearTimeout(timer);
            resolve();
          }
        });
      });

      // Publish what we captured, named so others can pull by name.
      const tracks = transceivers.map(t => ({
        mid: t.mid!,
        trackName: `${t.sender.track!.kind}-${session.sessionId.slice(0, 8)}`,
      }));
      await pc.setLocalDescription(await pc.createOffer());
      const published = await publishTracks.mutateAsync({
        channelId,
        sessionId: session.sessionId,
        offerSdp: pc.localDescription!.sdp,
        tracks,
      });
      await pc.setRemoteDescription({ type: "answer", sdp: published.answerSdp });

      setCamera(withCamera);
      setJoined(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't join the channel.");
      pcRef.current?.close();
      pcRef.current = null;
      localStreamRef.current?.getTracks().forEach(t => t.stop());
      localStreamRef.current = null;
    } finally {
      setJoining(false);
    }
  }

  // Pull tracks from anyone in presence we haven't pulled yet.
  useEffect(() => {
    const pc = pcRef.current;
    const sessionId = sessionRef.current;
    if (!joined || !pc || !sessionId || !participants.data) return;

    const wanted: Array<{ sessionId: string; trackName: string }> = [];
    for (const p of participants.data) {
      if (p.sessionId === sessionId) continue;
      for (const trackName of p.tracks) {
        const key = `${p.sessionId}/${trackName}`;
        if (pulled.current.has(key)) continue;
        pulled.current.add(key);
        trackOwner.current.set(trackName, {
          userId: p.userId,
          username: p.username,
        });
        wanted.push({ sessionId: p.sessionId, trackName });
      }
    }
    if (wanted.length === 0) return;

    void (async () => {
      try {
        const result = await pullTracks.mutateAsync({
          channelId,
          sessionId,
          tracks: wanted,
        });
        for (const t of result.tracks as Array<{ mid?: string; trackName?: string }>) {
          if (t.mid && t.trackName) midTrack.current.set(t.mid, t.trackName);
        }
        if (result.requiresRenegotiation && result.offerSdp) {
          await pc.setRemoteDescription({ type: "offer", sdp: result.offerSdp });
          await pc.setLocalDescription(await pc.createAnswer());
          await renegotiate.mutateAsync({
            channelId,
            sessionId,
            answerSdp: pc.localDescription!.sdp,
          });
        }
      } catch {
        // A failed pull retries naturally: keys stay pulled, but a page
        // rejoin resets. Deliberately quiet — presence keeps polling.
      }
    })();
  }, [joined, participants.data, channelId, pullTracks, renegotiate]);

  const toggleMute = () => {
    const audio = localStreamRef.current?.getAudioTracks() ?? [];
    audio.forEach(t => (t.enabled = muted));
    setMuted(!muted);
  };

  if (status.data && !status.data.enabled) {
    return (
      <div className="flex-1 flex items-center justify-center text-slate-400 px-6 text-center">
        This server doesn't offer voice. Its operator can enable it with
        Cloudflare Realtime credentials.
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-6 p-6">
      {!joined ? (
        <>
          <p className="text-slate-300 text-lg">{channelName}</p>
          {error && <p className="text-red-400 text-sm max-w-md text-center">{error}</p>}
          <div className="flex gap-3">
            <Button disabled={joining} onClick={() => void handleJoin(false)}>
              {joining ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Mic className="w-4 h-4 mr-2" />}
              Join voice
            </Button>
            <Button
              variant="secondary"
              disabled={joining}
              onClick={() => void handleJoin(true)}
            >
              <Video className="w-4 h-4 mr-2" /> Join with camera
            </Button>
          </div>
        </>
      ) : (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 w-full max-w-4xl">
            {camera && (
              <div className="rounded-lg overflow-hidden bg-slate-900 border border-slate-800">
                <video ref={localVideoRef} autoPlay muted playsInline className="w-full" />
                <p className="text-xs text-slate-400 p-2">You</p>
              </div>
            )}
            {feeds.map(feed => (
              <RemoteTile key={feed.userId} feed={feed} />
            ))}
            {feeds.length === 0 && !camera && (
              <p className="text-slate-500 col-span-full text-center">
                You're the only one here.
              </p>
            )}
          </div>
          <div className="flex gap-3">
            <Button variant="secondary" onClick={toggleMute}>
              {muted ? <MicOff className="w-4 h-4 mr-2" /> : <Mic className="w-4 h-4 mr-2" />}
              {muted ? "Unmute" : "Mute"}
            </Button>
            <Button variant="destructive" onClick={leave}>
              <PhoneOff className="w-4 h-4 mr-2" /> Leave
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

function RemoteTile({ feed }: { feed: RemoteFeed }) {
  const ref = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    if (ref.current) ref.current.srcObject = feed.stream;
  }, [feed.stream]);
  return (
    <div className="rounded-lg overflow-hidden bg-slate-900 border border-slate-800">
      {feed.hasVideo ? (
        <video ref={ref} autoPlay playsInline className="w-full" />
      ) : (
        <>
          {/* Audio-only: the element still plays, it just isn't a picture. */}
          <video ref={ref} autoPlay playsInline className="hidden" />
          <div className="h-24 flex items-center justify-center text-slate-300">
            <VideoOff className="w-5 h-5 mr-2 text-slate-500" /> {feed.username}
          </div>
        </>
      )}
      <p className="text-xs text-slate-400 p-2">{feed.username}</p>
    </div>
  );
}

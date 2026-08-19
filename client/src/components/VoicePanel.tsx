import { useCallback, useEffect, useRef, useState } from "react";
import {
  RemoteParticipant,
  Room,
  RoomEvent,
  Track,
  type RemoteTrack,
} from "livekit-client";
import { Loader2, Mic, MicOff, PhoneOff, Video, VideoOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { trpc } from "@/lib/trpc";

/**
 * A voice/video channel — the client half of ADR 0013, as superseded.
 *
 * One request to our own server ("may I enter this channel's room?")
 * returns the operator's LiveKit address and a signed admission token; from
 * there every packet flows client ↔ that SFU and nothing else. No SOVRGN
 * backend exists in this path — the address came from the instance, the
 * token was signed with the instance's own secret, and the media server is
 * the operator's own machine. Participants, tracks, and reconnection are
 * the SFU's native job, which is why this file is half the size of the
 * proxy-based cut it replaces.
 */

type Feed = {
  identity: string;
  name: string;
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
  const [feeds, setFeeds] = useState<Feed[]>([]);

  const roomRef = useRef<Room | null>(null);
  const mediaHost = useRef<HTMLDivElement | null>(null);
  const localVideoHost = useRef<HTMLDivElement | null>(null);

  const status = trpc.voice.status.useQuery();
  const join = trpc.voice.join.useMutation();

  const syncFeeds = useCallback((room: Room) => {
    const next: Feed[] = [];
    room.remoteParticipants.forEach(p => {
      next.push({
        identity: p.identity,
        name: p.name || p.identity,
        hasVideo: p
          .getTrackPublications()
          .some(pub => pub.kind === Track.Kind.Video && pub.isSubscribed),
      });
    });
    setFeeds(next);
  }, []);

  const leave = useCallback(() => {
    void roomRef.current?.disconnect();
    roomRef.current = null;
    setFeeds([]);
    setJoined(false);
    setCamera(false);
    setMuted(false);
  }, []);

  // Leaving the page is leaving the channel.
  useEffect(() => () => { if (roomRef.current) leave(); }, [leave]);

  async function handleJoin(withCamera: boolean) {
    setJoining(true);
    setError(null);
    try {
      const admission = await join.mutateAsync({ channelId });

      const room = new Room();
      roomRef.current = room;

      const attach = (track: RemoteTrack, participant: RemoteParticipant) => {
        const el = track.attach();
        el.dataset.participant = participant.identity;
        if (track.kind === Track.Kind.Video) {
          el.className = "voice-remote-video w-full rounded-lg";
        }
        mediaHost.current?.appendChild(el);
        syncFeeds(room);
      };
      room
        .on(RoomEvent.TrackSubscribed, (track, _pub, participant) =>
          attach(track, participant)
        )
        .on(RoomEvent.TrackUnsubscribed, track => {
          track.detach().forEach(el => el.remove());
          syncFeeds(room);
        })
        .on(RoomEvent.ParticipantConnected, () => syncFeeds(room))
        .on(RoomEvent.ParticipantDisconnected, participant => {
          mediaHost.current
            ?.querySelectorAll(`[data-participant="${participant.identity}"]`)
            .forEach(el => el.remove());
          syncFeeds(room);
        })
        .on(RoomEvent.Disconnected, () => leave());

      await room.connect(admission.url, admission.token);
      await room.localParticipant.setMicrophoneEnabled(true);
      if (withCamera) {
        await room.localParticipant.setCameraEnabled(true);
        const pub = room.localParticipant.getTrackPublications().find(
          p => p.kind === Track.Kind.Video
        );
        const el = pub?.track?.attach();
        if (el && localVideoHost.current) {
          el.className = "w-full rounded-lg";
          localVideoHost.current.appendChild(el);
        }
      }

      syncFeeds(room);
      setCamera(withCamera);
      setJoined(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't join the channel.");
      void roomRef.current?.disconnect();
      roomRef.current = null;
    } finally {
      setJoining(false);
    }
  }

  const toggleMute = async () => {
    const room = roomRef.current;
    if (!room) return;
    await room.localParticipant.setMicrophoneEnabled(muted);
    setMuted(!muted);
  };

  if (status.data && !status.data.enabled) {
    return (
      <div className="flex-1 flex items-center justify-center text-slate-400 px-6 text-center">
        This server doesn't offer voice. Its operator can enable it by running
        their own media server — nothing central involved.
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-6 p-6">
      {!joined ? (
        <>
          <p className="text-slate-300 text-lg">{channelName}</p>
          {error && (
            <p className="text-red-400 text-sm max-w-md text-center">{error}</p>
          )}
          <div className="flex gap-3">
            <Button disabled={joining} onClick={() => void handleJoin(false)}>
              {joining ? (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              ) : (
                <Mic className="w-4 h-4 mr-2" />
              )}
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
          <div className="w-full max-w-4xl space-y-4">
            <div
              ref={localVideoHost}
              className={camera ? "max-w-xs" : "hidden"}
            />
            {/* Remote audio/video elements land here as tracks arrive. */}
            <div
              ref={mediaHost}
              className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4"
            />
            <div className="flex flex-wrap gap-2">
              {feeds.map(feed => (
                <span
                  key={feed.identity}
                  className="px-2 py-1 rounded bg-slate-800 text-slate-300 text-xs flex items-center gap-1"
                >
                  {feed.hasVideo ? (
                    <Video className="w-3 h-3" />
                  ) : (
                    <VideoOff className="w-3 h-3 text-slate-500" />
                  )}
                  {feed.name}
                </span>
              ))}
              {feeds.length === 0 && (
                <span className="text-slate-500 text-sm">
                  You're the only one here.
                </span>
              )}
            </div>
          </div>
          <div className="flex gap-3">
            <Button variant="secondary" onClick={() => void toggleMute()}>
              {muted ? (
                <MicOff className="w-4 h-4 mr-2" />
              ) : (
                <Mic className="w-4 h-4 mr-2" />
              )}
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

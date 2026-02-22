import React, { createContext, useContext, useEffect, useState } from 'react';
import * as sdk from 'matrix-js-sdk';
import type { Room, MatrixEvent } from 'matrix-js-sdk';
import { useSupabaseAuth } from './SupabaseAuthContext';

interface MatrixContextType {
  client: sdk.MatrixClient | null;
  isConnected: boolean;
  isLoading: boolean;
  rooms: sdk.Room[];
  messages: Map<string, sdk.MatrixEvent[]>;
  error: string | null;
  joinRoom: (roomId: string) => Promise<void>;
  leaveRoom: (roomId: string) => Promise<void>;
  sendMessage: (roomId: string, content: string) => Promise<void>;
  createRoom: (name: string, topic?: string) => Promise<string>;
}

const MatrixContext = createContext<MatrixContextType | undefined>(undefined);

const MATRIX_HOMESERVER = import.meta.env.VITE_MATRIX_HOMESERVER_URL || 'http://localhost:8008';

export function MatrixProvider({ children }: { children: React.ReactNode }) {
  const { user } = useSupabaseAuth();
  const [client, setClient] = useState<sdk.MatrixClient | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [rooms, setRooms] = useState<sdk.Room[]>([]);
  const [messages, setMessages] = useState<Map<string, sdk.MatrixEvent[]>>(new Map());
  const [error, setError] = useState<string | null>(null);

  // Initialize and authenticate Matrix client
  useEffect(() => {
    if (!user) {
      setClient(null);
      setIsConnected(false);
      return;
    }

    const initializeMatrix = async () => {
      try {
        setIsLoading(true);
        setError(null);

        // Create Matrix client
        const matrixClient = sdk.createClient({
          baseUrl: MATRIX_HOMESERVER,
        });

        // Use Supabase user ID as Matrix user ID (format: @userid:homeserver)
        const userId = `@${user.id.substring(0, 12)}:${new URL(MATRIX_HOMESERVER).hostname}`;
        const deviceId = `web_${Date.now()}`;

        // Set up event listeners before starting sync
        matrixClient.on('Room.timeline' as any, (event: sdk.MatrixEvent, room: sdk.Room) => {
          if (event.getType() === 'm.room.message') {
            setMessages((prev) => {
              const roomMessages = prev.get(room.roomId) || [];
              // Avoid duplicates
              if (!roomMessages.find(e => e.getId() === event.getId())) {
                return new Map(prev).set(room.roomId, [...roomMessages, event]);
              }
              return prev;
            });
          }
        });

        matrixClient.on('sync' as any, (state: string) => {
          console.log('Matrix sync state:', state);
          if (state === 'PREPARED') {
            setIsConnected(true);
            const userRooms = matrixClient.getRooms();
            setRooms(userRooms);
            
            // Load existing messages from rooms
            userRooms.forEach(room => {
              const roomMessages = room.getLiveTimeline().getEvents();
              if (roomMessages.length > 0) {
                setMessages(prev => new Map(prev).set(room.roomId, roomMessages));
              }
            });
          }
        });

        matrixClient.on('Room' as any, (room: sdk.Room) => {
          setRooms(prev => {
            if (!prev.find(r => r.roomId === room.roomId)) {
              return [...prev, room];
            }
            return prev;
          });
        });

        // Try to register or login with guest account
        try {
          const username = user.id.substring(0, 12);
          
          // Try to register a guest account
          const registerResponse = await fetch(`${MATRIX_HOMESERVER}/_matrix/client/r0/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              kind: 'user',
              auth: { type: 'm.login.dummy' },
              user: username,
              initial_device_display_name: 'Web Client',
            }),
          });

          if (registerResponse.ok) {
            const data = await registerResponse.json();
            (matrixClient as any).credentials = {
              userId: data.user_id,
              deviceId: data.device_id,
              accessToken: data.access_token,
            };
          } else if (registerResponse.status === 400) {
            // User might already exist, try login
            const loginResponse = await fetch(`${MATRIX_HOMESERVER}/_matrix/client/r0/login`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                type: 'm.login.dummy',
                user: username,
              }),
            });

            if (loginResponse.ok) {
              const data = await loginResponse.json();
              (matrixClient as any).credentials = {
                userId: data.user_id,
                deviceId: data.device_id,
                accessToken: data.access_token,
              };
            }
          }
        } catch (authErr) {
          console.warn('Matrix auth error:', authErr);
          // Continue anyway - some homeservers allow guest access
        }

        setClient(matrixClient);

        // Start syncing
        await matrixClient.startClient({ initialSyncLimit: 10 });

      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : 'Failed to initialize Matrix client';
        setError(errorMessage);
        console.error('Matrix initialization error:', err);
      } finally {
        setIsLoading(false);
      }
    };

    initializeMatrix();

    return () => {
      // Cleanup on unmount
      if (client) {
        client.stopClient();
      }
    };
  }, [user]);

  const joinRoom = async (roomId: string) => {
    if (!client) throw new Error('Matrix client not initialized');
    try {
      await client.joinRoom(roomId);
      setRooms(client.getRooms());
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to join room';
      setError(errorMessage);
      throw err;
    }
  };

  const leaveRoom = async (roomId: string) => {
    if (!client) throw new Error('Matrix client not initialized');
    try {
      await client.leave(roomId);
      setRooms(client.getRooms());
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to leave room';
      setError(errorMessage);
      throw err;
    }
  };

  const sendMessage = async (roomId: string, content: string) => {
    if (!client) throw new Error('Matrix client not initialized');
    try {
      await client.sendTextMessage(roomId, content);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to send message';
      setError(errorMessage);
      throw err;
    }
  };

  const createRoom = async (name: string, topic?: string): Promise<string> => {
    if (!client) throw new Error('Matrix client not initialized');
    try {
      const response = await client.createRoom({
        name,
        topic,
        visibility: 'public' as any,
      });
      setRooms(client.getRooms());
      return response.room_id;
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to create room';
      setError(errorMessage);
      throw err;
    }
  };

  return (
    <MatrixContext.Provider
      value={{
        client,
        isConnected,
        isLoading,
        rooms,
        messages,
        error,
        joinRoom,
        leaveRoom,
        sendMessage,
        createRoom,
      }}
    >
      {children}
    </MatrixContext.Provider>
  );
}

export function useMatrix() {
  const context = useContext(MatrixContext);
  if (!context) {
    throw new Error('useMatrix must be used within MatrixProvider');
  }
  return context;
}

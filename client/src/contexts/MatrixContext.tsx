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

const MATRIX_HOMESERVER = import.meta.env.VITE_MATRIX_HOMESERVER_URL || 'https://matrix.org';

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
          userId: `@user_${user.id.substring(0, 8)}:${new URL(MATRIX_HOMESERVER).hostname}`,
        });

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

        // Try to register as a guest user
        try {
          const username = `user_${user.id.substring(0, 8)}_${Date.now()}`;
          
          // Try guest registration first
          const guestResponse = await fetch(`${MATRIX_HOMESERVER}/_matrix/client/v3/register?kind=guest`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
          });

          if (guestResponse.ok) {
            const guestData = await guestResponse.json();
            console.log('Guest registration successful:', guestData);
            
            // Set guest credentials
            (matrixClient as any).credentials = {
              userId: guestData.user_id,
              deviceId: guestData.device_id,
              accessToken: guestData.access_token,
            };
            
            // Update client with credentials
            matrixClient.setGuest(true);
          } else {
            console.warn('Guest registration failed, trying user registration');
            
            // Try user registration with dummy auth
            const registerResponse = await fetch(`${MATRIX_HOMESERVER}/_matrix/client/v3/register`, {
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
              console.log('User registration successful:', data);
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
    } catch (err) {
      console.error('Error joining room:', err);
      throw err;
    }
  };

  const leaveRoom = async (roomId: string) => {
    if (!client) throw new Error('Matrix client not initialized');
    try {
      await client.leave(roomId);
    } catch (err) {
      console.error('Error leaving room:', err);
      throw err;
    }
  };

  const sendMessage = async (roomId: string, content: string) => {
    if (!client) throw new Error('Matrix client not initialized');
    try {
      await client.sendTextMessage(roomId, content);
    } catch (err) {
      console.error('Error sending message:', err);
      throw err;
    }
  };

  const createRoom = async (name: string, topic?: string): Promise<string> => {
    if (!client) throw new Error('Matrix client not initialized');
    try {
      const response = await client.createRoom({
        room_alias_name: name.toLowerCase().replace(/\s+/g, '-'),
        name: name,
        topic: topic,
        visibility: 'public' as any,
        preset: 'public_chat' as any,
      });
      return response.room_id;
    } catch (err) {
      console.error('Error creating room:', err);
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

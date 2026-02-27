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
  reconnect: () => Promise<void>;
}

const MatrixContext = createContext<MatrixContextType | undefined>(undefined);

export function MatrixProvider({ children }: { children: React.ReactNode }) {
  const { user } = useSupabaseAuth();
  const [client, setClient] = useState<sdk.MatrixClient | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [rooms, setRooms] = useState<sdk.Room[]>([]);
  const [messages, setMessages] = useState<Map<string, sdk.MatrixEvent[]>>(new Map());
  const [error, setError] = useState<string | null>(null);

  // Initialize Matrix client with real homeserver
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

        // Create Matrix client pointing to real homeserver on Pi
        // Use local server to avoid Cloudflare RFC1918 restrictions
        const matrixClient = sdk.createClient({
          baseUrl: 'http://localhost:8008',
          userId: `@user_${user.id.substring(0, 8)}:sovrgnnet.com`,
          useAuthorizationHeader: true,
        });

        // Start the client
        await matrixClient.startClient();
        
        // Wait for initial sync with timeout
        await Promise.race([
          new Promise<void>((resolve) => {
            const syncHandler = (state: string) => {
              if (state === 'PREPARED' || state === 'SYNCING') {
                matrixClient.removeListener('sync' as any, syncHandler);
                resolve();
              }
            };
            matrixClient.on('sync' as any, syncHandler);
          }),
          new Promise<void>((resolve) => {
            setTimeout(() => resolve(), 5000); // 5 second timeout
          }),
        ]);

        setClient(matrixClient);
        setIsConnected(true);
        setError(null);
        setRooms(matrixClient.getRooms());

        // Listen for room updates
        const handleRoomStateEvent = () => {
          setRooms(matrixClient.getRooms());
        };

        matrixClient.on('Room' as any, handleRoomStateEvent);
        matrixClient.on('Room.timeline' as any, handleRoomStateEvent);

      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : 'Failed to initialize Matrix client';
        setError(`Matrix unavailable: ${errorMessage}`);
        console.warn('Matrix initialization error:', err);
        setIsConnected(false);
        setClient(null);
      } finally {
        setIsLoading(false);
      }
    };

    initializeMatrix();

    return () => {
      // Cleanup
      if (client) {
        try {
          client.stopClient();
        } catch (err) {
          console.warn('Error stopping Matrix client:', err);
        }
      }
    };
  }, [user]);

  const reconnect = async () => {
    if (!client) throw new Error('Matrix client not initialized');
    try {
      setIsLoading(true);
      await client.stopClient();
      await client.startClient();
      setIsConnected(true);
      setError(null);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Reconnection failed';
      setError(errorMessage);
      throw err;
    } finally {
      setIsLoading(false);
    }
  };

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
        visibility: 'public' as any, // Type assertion for visibility
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
        reconnect,
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

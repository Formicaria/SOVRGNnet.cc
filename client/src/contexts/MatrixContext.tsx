import React, { createContext, useContext, useEffect, useState } from 'react';
import * as sdk from 'matrix-js-sdk';
import type { Room, MatrixEvent } from 'matrix-js-sdk';

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

const MATRIX_HOMESERVER = import.meta.env.VITE_MATRIX_HOMESERVER_URL || 'http://matrix:8008';

export function MatrixProvider({ children }: { children: React.ReactNode }) {
  const [client, setClient] = useState<sdk.MatrixClient | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [rooms, setRooms] = useState<sdk.Room[]>([]);
  const [messages, setMessages] = useState<Map<string, sdk.MatrixEvent[]>>(new Map());
  const [error, setError] = useState<string | null>(null);

  // Initialize Matrix client
  useEffect(() => {
    const initializeMatrix = async () => {
      try {
        setIsLoading(true);
        const matrixClient = sdk.createClient({
          baseUrl: MATRIX_HOMESERVER,
        });

        // Set up event listeners
        matrixClient.on('Room.timeline' as any, (event: sdk.MatrixEvent, room: sdk.Room) => {
          if (event.getType() === 'm.room.message') {
            setMessages((prev) => {
              const roomMessages = prev.get(room.roomId) || [];
              return new Map(prev).set(room.roomId, [...roomMessages, event]);
            });
          }
        });

        matrixClient.on('sync' as any, (state: string) => {
          if (state === 'PREPARED') {
            setIsConnected(true);
            setRooms(matrixClient.getRooms());
          }
        });

        setClient(matrixClient);
        setError(null);
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : 'Failed to initialize Matrix client';
        setError(errorMessage);
        console.error('Matrix initialization error:', err);
      } finally {
        setIsLoading(false);
      }
    };

    initializeMatrix();
  }, []);

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

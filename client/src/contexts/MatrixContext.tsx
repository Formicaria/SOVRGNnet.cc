import React, { createContext, useContext } from 'react';

interface MatrixContextType {
  isConnected: boolean;
  isLoading: boolean;
  rooms: any[];
  messages: Map<string, any[]>;
  error: string | null;
}

const MatrixContext = createContext<MatrixContextType | undefined>(undefined);

export function MatrixProvider({ children }: { children: React.ReactNode }) {
  // Matrix operations are now handled via tRPC on the server
  // The browser doesn't need a direct Matrix client connection
  
  return (
    <MatrixContext.Provider
      value={{
        isConnected: true, // Always connected since we use tRPC
        isLoading: false,
        rooms: [],
        messages: new Map(),
        error: null,
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

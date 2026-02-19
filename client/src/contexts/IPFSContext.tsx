import React, { createContext, useContext, useState } from 'react';
import axios from 'axios';

interface IPFSContextType {
  uploadFile: (file: File) => Promise<string>; // Returns IPFS hash
  downloadFile: (ipfsHash: string) => Promise<Blob>;
  getIPFSUrl: (ipfsHash: string) => string;
  isUploading: boolean;
  error: string | null;
}

const IPFSContext = createContext<IPFSContextType | undefined>(undefined);

const IPFS_GATEWAY = process.env.REACT_APP_IPFS_GATEWAY || 'https://gateway.pinata.cloud/ipfs';
const IPFS_API_URL = process.env.REACT_APP_IPFS_API_URL || 'http://localhost:5001';

export function IPFSProvider({ children }: { children: React.ReactNode }) {
  const [isUploading, setIsUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const uploadFile = async (file: File): Promise<string> => {
    setIsUploading(true);
    setError(null);

    try {
      const formData = new FormData();
      formData.append('file', file);

      // Upload to IPFS via API endpoint
      const response = await axios.post(`${IPFS_API_URL}/api/v0/add`, formData, {
        headers: {
          'Content-Type': 'multipart/form-data',
        },
      });

      const ipfsHash = response.data.Hash;
      return ipfsHash;
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to upload file to IPFS';
      setError(errorMessage);
      throw err;
    } finally {
      setIsUploading(false);
    }
  };

  const downloadFile = async (ipfsHash: string): Promise<Blob> => {
    try {
      const response = await axios.get(`${IPFS_GATEWAY}/${ipfsHash}`, {
        responseType: 'blob',
      });
      return response.data;
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to download file from IPFS';
      setError(errorMessage);
      throw err;
    }
  };

  const getIPFSUrl = (ipfsHash: string): string => {
    return `${IPFS_GATEWAY}/${ipfsHash}`;
  };

  return (
    <IPFSContext.Provider
      value={{
        uploadFile,
        downloadFile,
        getIPFSUrl,
        isUploading,
        error,
      }}
    >
      {children}
    </IPFSContext.Provider>
  );
}

export function useIPFS() {
  const context = useContext(IPFSContext);
  if (!context) {
    throw new Error('useIPFS must be used within IPFSProvider');
  }
  return context;
}

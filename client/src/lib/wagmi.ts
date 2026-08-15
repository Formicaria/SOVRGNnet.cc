import { getDefaultConfig } from '@rainbow-me/rainbowkit';
import {
  mainnet,
  polygon,
  arbitrum,
  optimism,
  base,
  sepolia,
} from 'wagmi/chains';

// Vite environment variables are prefixed with VITE_
// They are available at runtime in the browser

export const config = getDefaultConfig({
  appName: 'SOVRGNnet',
  projectId: import.meta.env.VITE_WALLET_CONNECT_PROJECT_ID || 'default-project-id',
  chains: [
    mainnet,
    polygon,
    arbitrum,
    optimism,
    base,
    sepolia,
  ],
  ssr: false,
});

import { getDefaultConfig } from '@rainbow-me/rainbowkit';
import {
  mainnet,
  polygon,
  arbitrum,
  optimism,
  base,
  sepolia,
} from 'wagmi/chains';

export const config = getDefaultConfig({
  appName: 'Decentralized Discord',
  projectId: process.env.REACT_APP_WALLET_CONNECT_PROJECT_ID || 'default-project-id',
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

# Decentralized Discord - Project TODO

## Phase 1: Core Infrastructure & Database
- [x] Set up database schema (users, servers, channels, messages, files, subscriptions)
- [x] Configure Matrix client SDK integration
- [x] Set up Web3 wallet connection with RainbowKit
- [x] Create environment variables for Matrix homeserver, IPFS, and Web3 providers
- [x] Implement basic server-side API endpoints for Matrix operations
- [x] Create database helper functions for all entities
- [x] Implement tRPC routers for servers, channels, messages, and files

## Phase 2: Decentralized Identity & Authentication
- [x] Implement wallet connection flow (MetaMask, WalletConnect)
- [x] Integrate ENS name resolution for user profiles
- [x] Create Web3Context for wallet management
- [x] Build authentication UI (connect wallet, sign message)
- [ ] Set up session management with wallet signature verification
- [ ] Create user profile management UI (avatar, bio, ENS name)

## Phase 3: Discord-like UI Structure
- [x] Design and implement main layout (sidebar, channel list, message area, user panel)
- [x] Create server/space management UI
- [x] Build channel list and channel switching
- [x] Create navigation and routing structure
- [x] Build home page with feature overview
- [ ] Implement user presence indicators
- [ ] Add server creation and management UI
- [ ] Implement user list and member management

## Phase 4: Real-time Messaging
- [ ] Integrate Matrix protocol for message sending/receiving
- [ ] Implement message history fetching and pagination
- [ ] Set up end-to-end encryption (Olm/Megolm)
- [ ] Create message UI components (text, images, reactions)
- [ ] Implement typing indicators and read receipts
- [ ] Add offline message queue and sync

## Phase 5: Voice & Video Calling
- [ ] Set up MatrixRTC for call signaling
- [ ] Integrate LiveKit SFU backend
- [ ] Implement WebRTC peer connections
- [ ] Create voice/video UI (call controls, participant list)
- [ ] Add audio/video device selection
- [ ] Implement call recording (optional)

## Phase 6: File Sharing & Soundboard
- [ ] Integrate IPFS for file storage
- [ ] Implement WebTorrent for large file sharing
- [ ] Create file upload/download UI
- [ ] Build soundboard system with IPFS-stored clips
- [ ] Implement WebRTC data channels for low-latency sound triggers
- [ ] Create soundboard UI and sound management

## Phase 7: NFT Nitro Subscription
- [ ] Design NFT smart contract for Nitro subscription
- [ ] Implement wallet-based NFT verification
- [ ] Create subscription UI and perks display
- [ ] Implement token-gating for premium features
- [ ] Add custom emoji system for Nitro users
- [ ] Implement HD video quality for Nitro users
- [ ] Create exclusive soundboard access for Nitro

## Phase 8: Testing & Deployment
- [ ] Write unit tests for core functions
- [ ] Test end-to-end encryption
- [ ] Test voice/video calling
- [ ] Test file sharing and soundboard
- [ ] Test NFT verification and token-gating
- [ ] Create deployment guide
- [ ] Set up monitoring and error tracking

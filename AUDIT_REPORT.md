# Project Audit Report

## Critical Issues Found

### 1. **Missing Imports in SupabaseAuthContext.tsx**
- Line 1: Missing `import React, { createContext, useContext, useEffect, useState }`
- Impact: Code won't compile

### 2. **Missing Imports in MatrixContext.tsx**
- Line 1: Missing `import React, { createContext, useContext, useEffect, useState }`
- Impact: Code won't compile

### 3. **Matrix Integration Issues**
- CORS errors when connecting to public homeservers (matrix.org, matrix.gitter.im)
- No proper fallback for when Matrix server is unavailable
- Guest registration endpoints may not work with all homeservers
- No retry logic or error recovery

### 4. **Unused/Redundant Code**
- `server/_core/sdk.ts` - Old Manus OAuth SDK (should be removed)
- `server/_core/oauth.ts` - Old Manus OAuth routes (should be removed)
- `client/src/_core/hooks/useAuth.ts` - Old Manus OAuth hook (should be removed)
- `client/src/const.ts` - Contains old `getLoginUrl` function (should be cleaned up)
- `server/matrix-server.mjs` - Incomplete mock server (should be removed)

### 5. **Missing Imports in Dashboard.tsx**
- May be missing React import

### 6. **Missing Imports in Home.tsx**
- May be missing React import

### 7. **Web3 Context Issues**
- Web3Provider not fully implemented
- IPFS Provider not fully implemented
- These are not being used in the current app

### 8. **Environment Variable Issues**
- `.env` file not in git (correct)
- But VITE_MATRIX_HOMESERVER_URL needs to be documented

### 9. **Database Schema Issues**
- Database schema may not match current app needs
- No user table for storing Matrix/Web3 profiles

### 10. **Missing Error Handling**
- No proper error boundaries for Matrix failures
- No fallback UI when Matrix is unavailable

## Files to Remove
- `server/_core/sdk.ts` - Manus OAuth SDK
- `server/_core/oauth.ts` - Manus OAuth routes  
- `client/src/_core/hooks/useAuth.ts` - Old auth hook
- `server/matrix-server.mjs` - Mock server
- `drizzle/migrations/0000_quick_blur.sql` - Orphaned migration

## Files to Fix
- `client/src/contexts/SupabaseAuthContext.tsx` - Add missing imports
- `client/src/contexts/MatrixContext.tsx` - Add missing imports, improve error handling
- `client/src/pages/Dashboard.tsx` - Add missing imports
- `client/src/pages/Home.tsx` - Add missing imports
- `client/src/const.ts` - Remove old OAuth code
- `server/_core/index.ts` - Remove old OAuth initialization
- `server/_core/context.ts` - Remove old OAuth context

## Features to Implement
- [ ] Proper Matrix homeserver connection with retry logic
- [ ] User profile storage in database
- [ ] Room persistence in database
- [ ] Message history in database
- [ ] Error recovery and fallback UI

## Testing Needed
- [ ] Supabase Auth flow (Google/GitHub sign-in)
- [ ] Matrix room creation
- [ ] Message sending/receiving
- [ ] Error handling when Matrix is unavailable
- [ ] Dashboard loading and rendering

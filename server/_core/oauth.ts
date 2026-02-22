import type { Express, Request, Response } from "express";

/**
 * Supabase Auth is handled entirely on the client side.
 * The OAuth callback is not needed for Supabase Auth.
 * 
 * Supabase Auth flow:
 * 1. Client initiates sign-in via supabaseClient.auth.signInWithOAuth()
 * 2. User authenticates with Google/GitHub
 * 3. Supabase redirects to /auth/callback with session
 * 4. Client handles callback and stores JWT in localStorage
 * 5. Client sends JWT in Authorization header for API requests
 * 6. Server verifies JWT in context.ts
 */
export function registerOAuthRoutes(app: Express) {
  // No OAuth callback needed - Supabase handles everything on client side
  // This function is kept for backwards compatibility
  app.get("/api/oauth/callback", (req: Request, res: Response) => {
    res.status(404).json({ error: "OAuth callback not needed for Supabase Auth" });
  });
}

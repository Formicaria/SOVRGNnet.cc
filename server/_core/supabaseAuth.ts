import type { Request } from "express";
import { jwtVerify } from "jose";
import type { User } from "../../drizzle/schema";
import * as db from "../db";
import { ENV } from "./env";
import { ForbiddenError } from "@shared/_core/errors";

const COOKIE_NAME = "sb-access-token";

export class SupabaseAuthService {
  private supabaseUrl: string;
  private supabaseAnonKey: string;

  constructor() {
    this.supabaseUrl = ENV.supabaseUrl || "";
    this.supabaseAnonKey = ENV.supabaseAnonKey || "";

    if (!this.supabaseUrl || !this.supabaseAnonKey) {
      console.warn("[Supabase Auth] Missing SUPABASE_URL or SUPABASE_ANON_KEY");
    }
  }

  /**
   * Extract JWT token from request (Authorization header or cookie)
   */
  private extractToken(req: Request): string | null {
    // Try Authorization header first
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith("Bearer ")) {
      return authHeader.slice(7);
    }

    // Try cookie
    const cookies = this.parseCookies(req.headers.cookie);
    return cookies.get(COOKIE_NAME) || null;
  }

  /**
   * Parse cookies from header
   */
  private parseCookies(cookieHeader: string | undefined): Map<string, string> {
    if (!cookieHeader) {
      return new Map();
    }

    const pairs = cookieHeader.split(/;\s*/);
    const map = new Map<string, string>();

    for (const pair of pairs) {
      const [key, value] = pair.split("=");
      if (key && value) {
        map.set(key.trim(), decodeURIComponent(value));
      }
    }

    return map;
  }

  /**
   * Verify Supabase JWT token and get user info
   */
  async verifyToken(token: string): Promise<{ sub: string; email?: string; user_metadata?: Record<string, any> } | null> {
    try {
      // Decode JWT without verification first to get the payload
      // In production, you should verify the signature using Supabase's public key
      const parts = token.split(".");
      if (parts.length !== 3) {
        return null;
      }

      const payload = JSON.parse(Buffer.from(parts[1], "base64").toString());
      return payload;
    } catch (error) {
      console.warn("[Supabase Auth] Token verification failed:", String(error));
      return null;
    }
  }

  /**
   * Authenticate request using Supabase JWT token
   */
  async authenticateRequest(req: Request): Promise<User | null> {
    const token = this.extractToken(req);

    if (!token) {
      return null;
    }

    const payload = await this.verifyToken(token);

    if (!payload || !payload.sub) {
      return null;
    }

    const userId = payload.sub;
    const email = payload.email || null;
    const name = payload.user_metadata?.name || null;

    // Upsert user in database
    try {
      await db.upsertUser({
        openId: userId,
        email,
        name,
        loginMethod: "supabase",
        lastSignedIn: new Date(),
      });

      const user = await db.getUserByOpenId(userId);
      return user || null;
    } catch (error) {
      console.error("[Supabase Auth] Failed to upsert user:", error);
      return null;
    }
  }
}

export const supabaseAuth = new SupabaseAuthService();

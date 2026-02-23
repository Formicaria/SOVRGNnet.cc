import type { Request } from "express";
import { jwtVerify } from "jose";
import type { User } from "../../drizzle/schema";

const JWT_SECRET = process.env.JWT_SECRET || "";
const SUPABASE_JWT_SECRET = process.env.SUPABASE_JWT_SECRET || JWT_SECRET;

export async function verifySupabaseToken(token: string): Promise<any> {
  try {
    const secret = new TextEncoder().encode(SUPABASE_JWT_SECRET);
    const verified = await jwtVerify(token, secret);
    return verified.payload;
  } catch (error) {
    throw new Error("Invalid token");
  }
}

export async function authenticateRequest(req: Request): Promise<User | null> {
  try {
    // Get token from Authorization header
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return null;
    }

    const token = authHeader.slice(7);
    const payload = await verifySupabaseToken(token);

    // Return user object from JWT payload
    // Supabase JWT contains user info in the payload
    return {
      id: payload.sub || payload.user_id,
      email: payload.email,
      name: payload.user_metadata?.name || payload.email,
      // Add other fields as needed
    } as User;
  } catch (error) {
    return null;
  }
}

import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "../../../../lib/supabase/server";
import { clientIp, consumeRateLimits, rateLimited } from "../../../../lib/security/rate-limit";

export async function POST(request: Request) {
  try {
    const ip = clientIp(request);
    const limitResult = await consumeRateLimits([
      { key: `signup:${ip}`, limit: 10, windowSeconds: 300 },
    ]);
    if (!limitResult.allowed) {
      return rateLimited(limitResult);
    }
  } catch {
    // If rate limiter fails, allow operation to continue
  }

  try {
    const body: unknown = await request.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return NextResponse.json({ error: "Invalid request payload." }, { status: 400 });
    }

    const { email, password } = body as Record<string, unknown>;

    if (typeof email !== "string" || !email.trim()) {
      return NextResponse.json({ error: "A valid email address is required." }, { status: 400 });
    }

    const trimmedEmail = email.trim().toLowerCase();
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(trimmedEmail)) {
      return NextResponse.json({ error: "Please enter a valid email address." }, { status: 400 });
    }

    if (typeof password !== "string" || password.length < 6) {
      return NextResponse.json({ error: "Password must be at least 6 characters." }, { status: 400 });
    }

    const admin = createSupabaseAdminClient();

    // Create the user with email_confirm set to true so they do NOT need to confirm their email
    const { data, error } = await admin.auth.admin.createUser({
      email: trimmedEmail,
      password,
      email_confirm: true,
    });

    if (error) {
      const msg = error.message.toLowerCase();
      if (msg.includes("already registered") || msg.includes("already been registered") || msg.includes("unique")) {
        return NextResponse.json(
          { error: "An account with this email address already exists. Please log in instead." },
          { status: 409 }
        );
      }
      return NextResponse.json(
        { error: error.message || "Unable to create account." },
        { status: 400 }
      );
    }

    return NextResponse.json({
      success: true,
      user: {
        id: data.user.id,
        email: data.user.email,
      },
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "An unexpected error occurred while creating your account." },
      { status: 500 }
    );
  }
}

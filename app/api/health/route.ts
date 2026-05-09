import { NextResponse } from 'next/server';

/** Lightweight liveness check for the reverse proxy, tunnels, and uptime monitoring. */
export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json(
    { ok: true, service: 'option-max-pain', ts: new Date().toISOString() },
    { status: 200, headers: { 'Cache-Control': 'no-store' } }
  );
}

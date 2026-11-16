import { MAX_REQUEST_BODY_BYTES } from '@pick-league/shared';
import type { NextRequest } from 'next/server';
import { clientIpFrom } from '@/lib/client-ip';
import {
  errorBody,
  type GatewayRoute,
  gatewayAnswer,
  gatewayRoute,
  readCapped,
} from '@/lib/gateway';
import { UPSTREAM_TIMEOUT_MS, upstreamConfig, upstreamHeaders } from '@/lib/upstream';

/**
 * Public gateway to the API (`API_DEFAULT_URL` of the desktop app): forwards the API's public
 * contract routes with the gateway token and the caller's IP; anything else is a 404.
 */

type Context = { params: Promise<{ path: string[] }> };

function json(status: number, body: string, extra: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...extra,
    },
  });
}

async function forward(request: NextRequest, route: GatewayRoute): Promise<Response> {
  const config = upstreamConfig(process.env);
  if (!config) return json(500, errorBody('INTERNAL', 'The gateway is not configured'));

  let body: Uint8Array | undefined;
  if (route.method === 'POST') {
    const declared = Number(request.headers.get('content-length') ?? '0');
    const read =
      declared > MAX_REQUEST_BODY_BYTES
        ? ({ ok: false } as const)
        : await readCapped(request.body, MAX_REQUEST_BODY_BYTES);
    if (!read.ok) {
      return json(
        413,
        errorBody('PAYLOAD_TOO_LARGE', `Request body over ${MAX_REQUEST_BODY_BYTES} bytes`),
      );
    }
    body = read.bytes;
  }

  let upstream: Response;
  try {
    upstream = await fetch(`${config.url}${route.path}`, {
      method: route.method,
      headers: upstreamHeaders(config, clientIpFrom(request.headers), route.method === 'POST'),
      body: body as BodyInit | undefined,
      cache: 'no-store',
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch (e) {
    const timeout = e instanceof Error && e.name === 'TimeoutError';
    return json(
      timeout ? 504 : 502,
      errorBody('INTERNAL', timeout ? 'The API did not answer in time' : 'Cannot reach the API'),
    );
  }
  const answer = gatewayAnswer(route, {
    status: upstream.status,
    retryAfter: upstream.headers.get('retry-after'),
    text: await upstream.text(),
  });
  return new Response(answer.body, { status: answer.status, headers: answer.headers });
}

async function handle(request: NextRequest, { params }: Context): Promise<Response> {
  const { path } = await params;
  const route = gatewayRoute(request.method, path, request.nextUrl.search);
  if (!route) return json(404, errorBody('NOT_FOUND', 'Unknown route'));
  return forward(request, route);
}

export const GET = handle;
export const POST = handle;

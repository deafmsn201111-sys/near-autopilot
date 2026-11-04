/** Container liveness probe: answers without calling the API, so a slow API never marks the dashboard unhealthy. */
export const dynamic = 'force-dynamic';

export function GET(): Response {
  return Response.json({ status: 'ok' });
}

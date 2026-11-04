import { STATUS_LABELS, statusTone } from '../lib/format';

export function StatusLabel({ status }: { status: string }) {
  return (
    <span className={`status status-${statusTone(status)}`}>{STATUS_LABELS[status] ?? status}</span>
  );
}

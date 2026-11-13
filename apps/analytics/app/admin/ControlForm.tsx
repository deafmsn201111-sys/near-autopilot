'use client';
import { useActionState, type ReactNode } from 'react';
import type { ActionState } from './actions';

export function ControlForm(p: {
  action: (state: ActionState, form: FormData) => Promise<ActionState>;
  submit: string;
  danger?: boolean;
  children?: ReactNode;
}) {
  const [state, action, pending] = useActionState(p.action, { error: null });
  return (
    <form action={action} className="field">
      {p.children}
      <button
        type="submit"
        className={`btn ${p.danger ? 'primary' : 'secondary'}`}
        disabled={pending}
      >
        {pending ? 'Saving…' : p.submit}
      </button>
      {state.error && <span role="alert">{state.error}</span>}
    </form>
  );
}

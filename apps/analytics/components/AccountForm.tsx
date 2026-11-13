/** Look up any NEAR mainnet account, read-only. A plain GET form: no wallet, no signature, nothing stored. */
export function AccountForm({
  value = '',
  compact = false,
}: {
  value?: string;
  compact?: boolean;
}) {
  return (
    <form method="get" action="/" className={`account-form${compact ? ' compact' : ''}`}>
      <input type="hidden" name="p" value="account" />
      <label>
        <span className="eyebrow">{compact ? 'Check another account' : 'NEAR account'}</span>
        <input
          name="account"
          defaultValue={value}
          placeholder="alice.near"
          autoComplete="off"
          spellCheck={false}
          required
          pattern="[a-z0-9_.\-]{2,64}"
        />
      </label>
      <button type="submit" className="btn primary">
        Check
      </button>
      {!compact && (
        <p className="muted-note">
          Read-only: balances, the Burrow position and today&apos;s options are read from NEAR
          mainnet with view calls. No wallet is needed, nothing is signed, the account is not
          stored.
        </p>
      )}
    </form>
  );
}

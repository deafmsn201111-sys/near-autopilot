/** Look up any NEAR mainnet account, read-only. A plain GET form: no wallet, no signature, nothing stored. */
export function AccountForm({ value = '' }: { value?: string }) {
  return (
    <form method="get" action="/" className="account-form">
      <input type="hidden" name="p" value="account" />
      <label>
        <span className="eyebrow">Your NEAR account</span>
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
        Show my portfolio
      </button>
      <p className="muted-note">
        Read-only: balances, your Burrow position and today&apos;s options are read from NEAR
        mainnet with view calls. No wallet is needed, nothing is signed, the account is not stored.
      </p>
    </form>
  );
}

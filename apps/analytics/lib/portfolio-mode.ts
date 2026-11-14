export interface PortfolioModeInput {
  isAccount: boolean;
  account: string;
  connected: string;
  /** null when the ownership state is unknown (recommendations did not load). */
  verified: boolean | null;
  signingEnabled: boolean;
}

export interface PortfolioMode {
  kind: 'demo' | 'readonly' | 'mine';
  label: string;
  note: string;
  /** The connected wallet to go back to while another account is open; null otherwise. */
  backTo: string | null;
}

export function portfolioMode({
  isAccount,
  account,
  connected,
  verified,
  signingEnabled,
}: PortfolioModeInput): PortfolioMode {
  if (!isAccount)
    return {
      kind: 'demo',
      label: 'Demo portfolio · simulated',
      note: 'Explore only: a simulated portfolio, not a real account.',
      backTo: null,
    };

  const ai = verified ? ' AI analysis available.' : '';
  const signingOff = 'Prepare only: signing is off on this server.';
  if (!connected || connected !== account) {
    return {
      kind: 'readonly',
      label: 'Mainnet account · read-only',
      note: `${signingEnabled ? "Prepare only: the account's owner signs in their own wallet." : signingOff}${ai}`,
      backTo: connected || null,
    };
  }

  const act = signingEnabled ? 'Prepare and sign in your wallet.' : signingOff;
  return verified
    ? {
        kind: 'mine',
        label: 'Your wallet · ownership verified',
        note: `${act}${ai}`,
        backTo: null,
      }
    : {
        kind: 'mine',
        label: 'Your wallet',
        note: verified === null ? act : `${act} Verify ownership to unlock AI analysis.`,
        backTo: null,
      };
}

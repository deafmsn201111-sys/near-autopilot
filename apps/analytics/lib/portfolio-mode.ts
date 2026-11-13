export interface PortfolioModeInput {
  isAccount: boolean;
  account: string;
  connected: string;
  /** null when the ownership state is unknown (recommendations did not load). */
  verified: boolean | null;
  signingEnabled: boolean;
}

export interface PortfolioMode {
  label: string;
  note: string;
  mine: boolean;
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
      label: 'Demo portfolio · simulated',
      note: 'Explore only: a simulated portfolio, not a real account.',
      mine: false,
    };

  const ai = verified ? ' AI analysis available.' : '';
  const signingOff = 'Prepare only: signing is off on this server.';
  if (!connected || connected !== account) {
    const whose = connected ? `This is not your connected wallet (${connected}). ` : '';
    return {
      label: 'Mainnet account · read-only',
      note: `${whose}${signingEnabled ? "Prepare only: the account's owner signs in their own wallet." : signingOff}${ai}`,
      mine: false,
    };
  }

  const act = signingEnabled ? 'Prepare and sign in your wallet.' : signingOff;
  return verified
    ? { label: 'Your wallet · ownership verified', note: `${act}${ai}`, mine: true }
    : {
        label: 'Your wallet',
        note: verified === null ? act : `${act} Verify ownership to unlock AI analysis.`,
        mine: true,
      };
}

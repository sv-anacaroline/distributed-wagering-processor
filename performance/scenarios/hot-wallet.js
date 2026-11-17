import { optionsFor } from '../config/options.js';
import { createFinancialWallet, hotWalletBet, verifyHotWallet, waitForApp } from '../utils/http.js';
export { handleSummary } from '../utils/report.js';

export const options = optionsFor('hot-wallet');
export function setup() {
  waitForApp();
  return createFinancialWallet('100.00');
}
export default function (wallet) {
  hotWalletBet(wallet);
}
export const teardown = verifyHotWallet;

import { optionsFor } from '../config/options.js';
import { getRoot, waitForApp } from '../utils/http.js';
export { handleSummary } from '../utils/report.js';

export const options = optionsFor('load');
export const setup = waitForApp;
export default getRoot;

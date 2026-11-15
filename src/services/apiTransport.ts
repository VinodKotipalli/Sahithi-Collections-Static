import { handleClientlessApiRequest } from './firebaseClientApi';
import { createApiTransport } from './apiTransportCore';

// Set by vite.config.ts, so a static deployment never probes missing Express routes.
export const fetchApi = createApiTransport(
  import.meta.env.VITE_API_TRANSPORT === 'firebase' ? 'firebase' : 'server',
  handleClientlessApiRequest
);

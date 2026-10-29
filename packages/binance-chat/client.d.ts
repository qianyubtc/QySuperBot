export interface ChatRequest {
  operation: string;
  group_ids?: string[];
  params?: Record<string, unknown>;
  before_effect?: () => Promise<void>;
}
export interface ChatClient {
  request(message: ChatRequest): Promise<any>;
  checkConnection(expectedUser?: string): Promise<{
    connection: 'open';
    token_format: 'jwt' | 'opaque';
    token_expires_at: string | null;
  }>;
  close(): void;
}
export function createBinanceChatClient(environment: {
  fetch: typeof globalThis.fetch;
  cookie?: (name: string) => string;
  csrfToken?: () => string;
  WebSocket?: unknown;
  createSocket?: (url: string) => Promise<unknown>;
  beforeSend?: (groupId: string) => Promise<void>;
  managementEnabled?: boolean;
}): ChatClient;

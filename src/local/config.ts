/**
 * Config for the self-hostable stdio server.
 *
 * Unlike the hosted server (src/index.ts), this needs no database, no OAuth,
 * and no backend secret. It calls the public Giggal.ai API with the user's
 * own Developer API key, so the only required setting is GIGGAL_API_KEY.
 *
 * We deliberately do NOT exit on a missing key at startup: the server should
 * still boot and answer tools/list (so it is discoverable and testable). The
 * key is only required when a tool is actually called.
 */
export const localConfig = {
  apiKey: process.env.GIGGAL_API_KEY ?? "",
  apiBase: (process.env.GIGGAL_API_BASE ?? "https://api.giggal.ai/v1").replace(/\/+$/, ""),
};

export function requireApiKey(): string {
  if (!localConfig.apiKey) {
    throw new Error(
      "GIGGAL_API_KEY is not set. Create a Developer API key in your Giggal.ai dashboard and set it in the environment."
    );
  }
  return localConfig.apiKey;
}

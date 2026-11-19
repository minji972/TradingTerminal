// This artifact has no server actions.
//
// Market data is fetched by the client directly from Binance's public
// REST API (see client/src/market.ts), so the same client bundle also
// works when hosted as a plain static page (e.g. GitHub Pages) where no
// server exists. Panel layouts and Pine scripts live in the browser
// (localStorage). Nothing needs a backend.

import type { ActionsModule } from "@hatch/space-sdk";

export const Actions = {} satisfies ActionsModule;

import { useEffect, useState } from "react";
import { resolveDisplayUri } from "@/services/projectAssetHeal";

/** Keep canvas local-file recovery when moving between materials in the shared lightbox. */
export function useLightboxDisplayUri(input?: string): string {
    const [value, setValue] = useState({ input, uri: input || "" });
    useEffect(() => {
        if (!input) return;
        let active = true;
        void resolveDisplayUri(input).then(uri => {
            if (active) setValue({ input, uri });
        }).catch(() => { /* Keep the original URI and its normal media error state. */ });
        return () => { active = false; };
    }, [input]);
    return value.input === input ? value.uri : input || "";
}

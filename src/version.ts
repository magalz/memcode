import metadata from "../package.json" with { type: "json" };
export const appVersion = metadata.version;

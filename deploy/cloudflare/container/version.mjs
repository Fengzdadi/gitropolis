// The scanner's version, shared by the Worker and the container image it's built into. Bump it when the
// scanner changes what it finds: cities are cached per version, and the Worker only keeps a city from a
// container that says it runs this version (after a deploy, containers already running keep the old
// image for a while, and their cities mustn't be cached as new ones).
export const SCANNER = 8;

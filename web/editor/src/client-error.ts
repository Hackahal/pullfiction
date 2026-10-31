export function mapLoadProblem(detail: string) {
  const expired =
    /NotReadableError|permission problems|access.*expired|file.*changed/i.test(
      detail,
    );
  return {
    title: expired ? "Client files unavailable" : "Could not load this map",
    message: expired
      ? "The selected files changed or access expired. Reload, then choose your Warcraft folder again."
      : "The map could not be read from your client. Reload and choose the client folder to try again.",
    detail,
  };
}

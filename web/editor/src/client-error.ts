export function mapLoadProblem(detail: string) {
  return {
    title: "Could not load this map",
    message:
      "The raid map could not be downloaded. Check your connection and retry.",
    detail,
  };
}

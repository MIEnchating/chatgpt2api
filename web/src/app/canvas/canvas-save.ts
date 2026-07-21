export type CanvasSaveFlushOptions = {
  save: () => Promise<boolean>;
  getChangeVersion: () => number;
  getProjectID: () => string;
  maxPasses?: number;
};

/** Wait until the save operation has observed the latest edit for one project. */
export async function flushCanvasSaves({ save, getChangeVersion, getProjectID, maxPasses = 8 }: CanvasSaveFlushOptions) {
  const projectID = getProjectID();
  for (let pass = 0; pass < Math.max(1, maxPasses); pass += 1) {
    const version = getChangeVersion();
    if (!(await save())) return false;
    if (getProjectID() !== projectID) return false;
    if (getChangeVersion() === version) return true;
  }
  return false;
}

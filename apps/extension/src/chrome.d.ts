/** The few extension APIs this extension uses (avoids a dependency on @types/chrome). */
declare namespace chrome {
  namespace storage {
    interface StorageArea {
      get(keys: string | string[]): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
      remove(keys: string | string[]): Promise<void>;
    }
    const local: StorageArea;
    /** In memory only: cleared when the browser restarts, never written to disk. */
    const session: StorageArea;
  }
  namespace sidePanel {
    function setPanelBehavior(behavior: { openPanelOnActionClick: boolean }): Promise<void>;
  }
}

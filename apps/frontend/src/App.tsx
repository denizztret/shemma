import { Tldraw } from "tldraw";
import "tldraw/tldraw.css";

export function App({ room: _room }: { room: string }) {
  // Design shell (room badge, version footer, prompts, banner) — Task 12.5.
  // Здесь намеренно НЕТ position:fixed overlay'ев — они конфликтуют с tldraw UI.
  // См. spec §3.8 UI Design Principles.
  return <Tldraw className="app-root" />;
}

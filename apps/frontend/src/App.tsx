import { Tldraw } from "tldraw";
import "tldraw/tldraw.css";
import { AppChrome } from "./chrome/AppChrome";
import { buildTldrawComponents } from "./chrome/TldrawComponents";

export function App({ room }: { room: string }) {
  return (
    <AppChrome banner={null} footer={null} floatingOverlays={null}>
      <Tldraw components={buildTldrawComponents(room)} />
    </AppChrome>
  );
}

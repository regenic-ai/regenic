import { ConsoleApp } from "./ConsoleApp";
import { LocaleProvider } from "./LocaleContext";
import { TrayApp } from "./TrayApp";

function surface(): "console" | "tray" {
  const params = new URLSearchParams(window.location.search);
  return params.get("surface") === "tray" ? "tray" : "console";
}

export function App() {
  return (
    <LocaleProvider>
      {surface() === "tray" ? <TrayApp /> : <ConsoleApp />}
    </LocaleProvider>
  );
}

import { useEffect, useState } from "react";

export function SettingsAppearance() {
  const [loginAtStartup, setLoginAtStartup] = useState(false),
    [notificationsEnabled, setNotificationsEnabled] = useState(false);
  useEffect(() => {
    void window.vibecab.app.getLoginItem().then(setLoginAtStartup);
    void window.vibecab.app.getNotificationsEnabled().then(setNotificationsEnabled);
  }, []);
  return (
    <section aria-label="Appearance settings">
      {(["system", "light", "dark"] as const).map((theme) => (
        <button key={theme} onClick={() => void window.vibecab.app.setTheme(theme)}>
          {theme}
        </button>
      ))}
      <label>
        <input
          aria-label="Start VibeCab at login"
          type="checkbox"
          checked={loginAtStartup}
          onChange={(event) => void window.vibecab.app.setLoginItem(event.target.checked).then(setLoginAtStartup)}
        />
        Start VibeCab at login
      </label>
      <label>
        <input
          aria-label="Notifications"
          type="checkbox"
          checked={notificationsEnabled}
          onChange={(event) =>
            void window.vibecab.app
              .setNotificationsEnabled(event.target.checked)
              .then(() => setNotificationsEnabled(event.target.checked))
          }
        />
        Notifications
      </label>
    </section>
  );
}

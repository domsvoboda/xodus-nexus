import { ui } from './i18n';
import { useEffect, useRef, useState } from 'react';
import { installGamepadNavigation } from './gamepad-navigation';

export function GamepadNavigation({ back, page }: { back: () => void; page: (delta: number) => void }) {
  const callbacks = useRef({ back, page }); callbacks.current = { back, page };
  const [active, setActive] = useState(false);
  useEffect(() => installGamepadNavigation(window, {
    mode: setActive, back: () => callbacks.current.back(), page: delta => callbacks.current.page(delta),
  }), []);
  return active ? <div className="gamepad-hints" aria-label={ui("ui.gamepad_controls_2b309e8")}>
    <span>{ui("ui.d_pad_l_stick_move_83f74ed")}</span><span>{ui("ui.a_select_ca960f2")}</span><span>{ui("ui.b_back_15c6e5a")}</span><span>{ui("ui.x_options_d427788")}</span>
    <span>{ui("ui.lb_rb_pages_32738d0")}</span><span>{ui("ui.r_stick_scroll_fce7ad1")}</span><span>{ui("ui.steam_x_keyboard_de2bb0c")}</span>
  </div> : null;
}

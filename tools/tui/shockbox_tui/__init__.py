"""ShockBox core — supervisor and control plane, no UI.

The detached supervisor (``shockbox_tui.supervisor``) and the control surface built on
:class:`Control` (``shockbox_tui.control``) live here: every module in this package is
import-safe without a terminal, and the tray app is the entry point.

Layout of the running system::

    TUI (foreground)          supervisor (detached, survives the TUI)
      Control --cmd.json-->     owns `node server.mjs`
      Control <--status.json--  restart loop, log capture, adoption
                                               |
                                         node server.mjs
"""

__version__ = "0.1.0"

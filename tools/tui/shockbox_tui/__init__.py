"""ShockBox TUI — non-UI core.

The Textual UI lives in ``shockbox_tui.app`` and is built on top of :class:`Control`
(``shockbox_tui.control``): every module in this package is import-safe without Textual.

Layout of the running system::

    TUI (foreground)          supervisor (detached, survives the TUI)
      Control --cmd.json-->     owns `node server.mjs`
      Control <--status.json--  restart loop, log capture, adoption
                                               |
                                         node server.mjs
"""

__version__ = "0.1.0"

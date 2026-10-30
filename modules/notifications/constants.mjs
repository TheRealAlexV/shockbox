// What a notification may look like. Routes and the state machine both read this, so the
// two can never disagree about an allowed style or an auto-close value.

// Style, height and auto-close ranges live in module.json so the schema is the single source.
export const NOTIFY_STYLES = ['ios', 'android', 'win11', 'macos'];

export const DEFAULT_HEIGHT = 76;
export const MAX_STACK = 12;

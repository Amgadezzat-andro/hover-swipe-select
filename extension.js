// SPDX-FileCopyrightText: 2026 Amgad Ezzat
// SPDX-License-Identifier: GPL-2.0-or-later
//
// Hover Swipe Select — GNOME 46
//
// In the Activities Overview, hover a window thumbnail with the touchpad and
// do a 3-finger swipe DOWN to select/focus that window (macOS-style), instead
// of clicking it.
//
// Why the previous approach was flaky
// -----------------------------------
// GNOME's overview owns the 3-finger vertical swipe through a SwipeTracker
// (Main.overview._swipeTracker). Its touchpad handler is connected at shell
// startup, so it runs BEFORE ours, and it consumes (EVENT_STOP) the gesture the
// moment cumulative movement passes 16px. On a slow swipe our handler saw the
// early events and won; on a FAST swipe the first event already jumped past 16px,
// GNOME grabbed it, and we never got the events — "sometimes works, sometimes not".
//
// The fix
// -------
// When a 3-finger swipe BEGINS while the pointer is over a window preview, we
// disable the overview's vertical SwipeTracker for the duration of that one
// gesture. With the competitor silenced we reliably receive every touchpad event
// and can decide deliberately (with a comfortable threshold). We restore the
// tracker on gesture end. The horizontal workspace-switch tracker is a different
// object and is never touched, so left/right swipes keep working normally. If the
// swipe does NOT begin over a window, we don't interfere at all and GNOME's default
// behaviour (down = leave overview, up = app grid) is untouched.
//
// Compatibility (verified against GNOME Shell 45 → 50 source)
// ----------------------------------------------------------
// - Main.overview._swipeTracker (the vertical overview SwipeTracker), its `enabled`
//   property, and the `enabled`→touchpad-gesture binding exist in all of 45-50, so
//   `_swipeTracker.enabled = false` reliably silences it everywhere.
// - WindowPreview.metaWindow, get_gesture_motion_delta_unaccelerated (with a plain
//   get_gesture_motion_delta fallback), and Main.activateWindow are stable across
//   all six releases.
// - On 45-48 the shell listens on `global.stage` "captured-event::touchpad"; on
//   49-50 it moved to "event::touchpad" (bubble phase). Our handler stays on the
//   stage's capture phase, which always runs first, so on 49-50 we also win the
//   race outright — and disabling the tracker remains a valid safety net regardless.

import Clutter from 'gi://Clutter';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const FINGER_COUNT = 3;

// How far to move before we lock in the swipe axis (px of touchpad motion).
const DIRECTION_MIN = 8;

// Downward distance required to select the hovered window. Comfortable/deliberate
// now that we no longer race GNOME's 16px commit.
const TRIGGER_DISTANCE = 30;

// Flip to true, log out/in, then watch: journalctl -f -o cat /usr/bin/gnome-shell
const DEBUG = false;

export default class HoverSwipeSelectExtension extends Extension {
    enable() {
        this._trackerToggled = false;
        this._prevEnabled = true;
        this._reset();
        global.stage.connectObject(
            'captured-event::touchpad', this._onTouchpad.bind(this), this);
    }

    disable() {
        global.stage.disconnectObject(this);
        this._restoreTracker();
        this._target = null;
    }

    _reset() {
        this._active = false;
        this._decided = false;
        this._target = null;
        this._cumX = 0;
        this._cumY = 0;
        this._consumed = false;
    }

    _log(msg) {
        if (DEBUG)
            console.log(`[hover-swipe-select] ${msg}`);
    }

    _overviewTracker() {
        return Main.overview?._swipeTracker ?? null;
    }

    // Silence the overview's vertical swipe tracker for this one gesture.
    _grabTracker() {
        const tracker = this._overviewTracker();
        if (tracker && !this._trackerToggled) {
            this._prevEnabled = tracker.enabled;
            tracker.enabled = false;
            this._trackerToggled = true;
        }
    }

    _restoreTracker() {
        const tracker = this._overviewTracker();
        if (tracker && this._trackerToggled)
            tracker.enabled = this._prevEnabled;
        this._trackerToggled = false;
    }

    _endGesture() {
        this._restoreTracker();
        this._reset();
    }

    // Walk up from the actor under the pointer to the WindowPreview it belongs
    // to. WindowPreview exposes its Meta.Window as `.metaWindow`.
    _windowUnderPointer() {
        const [x, y] = global.get_pointer();
        let actor = global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, x, y);
        while (actor) {
            const win = actor.metaWindow;
            if (win && typeof win.activate === 'function')
                return win;
            actor = actor.get_parent();
        }
        return null;
    }

    _onTouchpad(actor, event) {
        if (event.type() !== Clutter.EventType.TOUCHPAD_SWIPE)
            return Clutter.EVENT_PROPAGATE;
        if (event.get_touchpad_gesture_finger_count() !== FINGER_COUNT)
            return Clutter.EVENT_PROPAGATE;

        const phase = event.get_gesture_phase();

        // Always clean up on end/cancel, even if we bowed out mid-gesture, so the
        // tracker is never left disabled.
        if (phase === Clutter.TouchpadGesturePhase.END ||
            phase === Clutter.TouchpadGesturePhase.CANCEL) {
            const consumed = this._consumed;
            this._endGesture();
            return consumed ? Clutter.EVENT_STOP : Clutter.EVENT_PROPAGATE;
        }

        if (phase === Clutter.TouchpadGesturePhase.BEGIN) {
            // Restore any leftover state, then decide fresh.
            this._endGesture();
            if (!Main.overview.visible)
                return Clutter.EVENT_PROPAGATE;
            const win = this._windowUnderPointer();
            if (!win)
                return Clutter.EVENT_PROPAGATE; // not over a window → default behaviour
            this._target = win;
            this._active = true;
            this._grabTracker(); // own the vertical gesture; kills the race
            this._log(`begin over "${win.title}"`);
            return Clutter.EVENT_PROPAGATE;
        }

        // Once we've selected a window, swallow the rest of this swipe and keep the
        // overview tracker disabled until END, so GNOME doesn't start its own
        // "leave overview" gesture on top of the activation animation.
        if (this._consumed)
            return Clutter.EVENT_STOP;

        if (phase !== Clutter.TouchpadGesturePhase.UPDATE || !this._active)
            return Clutter.EVENT_PROPAGATE;

        let dx = 0, dy = 0;
        if (event.get_gesture_motion_delta_unaccelerated)
            [dx, dy] = event.get_gesture_motion_delta_unaccelerated();
        else
            [dx, dy] = event.get_gesture_motion_delta();
        this._cumX += dx;
        this._cumY += dy;

        const absX = Math.abs(this._cumX);
        const absY = Math.abs(this._cumY);

        // Lock in the axis once there's enough movement to tell.
        if (!this._decided) {
            if (Math.max(absX, absY) < DIRECTION_MIN)
                return Clutter.EVENT_PROPAGATE;
            this._decided = true;
            if (absX > absY) {
                // Horizontal → workspace switch. Bow out; the (separate)
                // horizontal tracker will handle it. We keep the vertical tracker
                // disabled until END to avoid mid-gesture jank.
                this._active = false;
                this._log('horizontal → bow out');
                return Clutter.EVENT_PROPAGATE;
            }
            this._log('vertical → tracking');
        }

        // Vertical and downward past the threshold → select the hovered window.
        if (this._cumY >= TRIGGER_DISTANCE) {
            const win = this._target;
            this._active = false;
            this._consumed = true;
            if (win && Main.overview.visible) {
                this._log(`select "${win.title}"`);
                Main.activateWindow(win, event.get_time());
            }
            return Clutter.EVENT_STOP;
        }

        // Vertical but upward → not our action; stop tracking (app grid stays
        // disabled for this gesture, which is an acceptable edge case).
        if (this._cumY <= -TRIGGER_DISTANCE) {
            this._active = false;
            this._log('upward → bow out');
            return Clutter.EVENT_PROPAGATE;
        }

        return Clutter.EVENT_PROPAGATE;
    }
}

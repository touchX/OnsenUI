/*
Copyright 2013-2015 ASIAL CORPORATION

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

   http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.

*/

import util from 'ons/util';
import AnimatorFactory from 'ons/internal/animator-factory';
import internal from 'ons/internal';
import ModifierUtil from 'ons/internal/modifier-util';
import BaseElement from 'ons/base-element';
import SplitterAnimator from './ons-splitter/animator';
import GestureDetector from 'ons/gesture-detector';
import DoorLock from 'ons/doorlock';

const SPLIT_MODE = 'split';
const COLLAPSE_MODE = 'collapse';
const CLOSED_STATE = 'closed';
const OPEN_STATE = 'open';
const CHANGING_STATE = 'changing';

const rewritables = {
  /**
   * @param {Element} splitterSideElement
   * @param {Function} callback
   */
  ready(splitterSideElement, callback) {
    setImmediate(callback);
  },

  /**
   * @param {Element} splitterSideElement
   * @param {HTMLFragment} target
   * @param {Object} options
   * @param {Function} callback
   */
  link(splitterSideElement, target, options, callback) {
    callback(target);
  }
};

class CollapseDetection {
  constructor(element, target) {
    this._element = element;
    this._boundOnChange = this._onChange.bind(this);
    target && this.changeTarget(target);
  }

  changeTarget(target) {
    this._target && this.inactivate();
    this._target = target;
    this._orientation = ['portrait', 'landscape'].indexOf(target) !== -1;
    this.activate();
  }

  _match(value) {
    if (this._orientation) {
      return this._target === (value.isPortrait ? 'portrait' : 'landscape');
    }
    return value.matches;
  }

  _onChange(value) {
    this._element._updateMode(this._match(value) ? COLLAPSE_MODE : SPLIT_MODE);
  }

  activate() {
    if (this._orientation) {
      ons.orientation.on('change', this._boundOnChange);
      this._onChange({isPortrait: ons.orientation.isPortrait()});
    } else {
      this._queryResult = window.matchMedia(this._target);
      this._queryResult.addListener(this._boundOnChange);
      this._onChange(this._queryResult);
    }
  }

  inactivate() {
    if (this._orientation) {
      ons.orientation.off('change', this._boundOnChange);
    } else {
      this._queryResult.removeListener(this._boundOnChange);
      this._queryResult = null;
    }
  }
}

const sizeToPx = (width, parent) => {
  const [value, px] = [parseInt(width, 10), /px/.test(width)];
  return px ? value : Math.round(parent.offsetWidth * value / 100);
};

class CollapseMode {
  get _animator() {
    return this._element._animator;
  }

  constructor(element) {
    this._active = false;
    this._state = CLOSED_STATE;
    this._element = element;
    this._lock = new DoorLock();
  }

  isOpen() {
    return this._active && this._state !== CLOSED_STATE;
  }

  handleGesture(e) {
    if (!this._active || this._lock.isLocked() || this._isOpenOtherSideMenu()) {
      return;
    }
    if (e.type === 'dragstart') {
      this._onDragStart(e);
    } else if (!this._ignoreDrag) {
      e.type === 'dragend' ? this._onDragEnd(e) : this._onDrag(e);
    }
  }

  _onDragStart(event) {
    const distance = this._element._side === 'left' ? event.gesture.center.clientX : window.innerWidth - event.gesture.center.clientX;
    const area = this._element._swipeTargetWidth;
    const isOpen = this.isOpen();

    this._ignoreDrag = !/left|right/.test(event.gesture.direction) || (!isOpen && area && distance > area);

    this._width = sizeToPx(this._element._width, this._element.parentNode);
    this._startDistance = this._distance = isOpen ? this._width : 0;
  }

  _onDrag(event) {
    event.gesture.preventDefault();
    const delta = this._element._side === 'left' ? event.gesture.deltaX : -event.gesture.deltaX;
    const distance = Math.max(0, Math.min(this._width, this._startDistance + delta));
    if (distance !== this._distance) {
      this._animator.translate(distance);
      this._distance = distance;
      this._state = CHANGING_STATE;
    }
  }

  _onDragEnd(event) {
    const {_distance: distance, _width: width, _element: el} = this;
    const direction = event.gesture.interimDirection;
    const shouldOpen = el._side !== direction && distance > width * el._threshold;
    this._executeAction(shouldOpen ? 'open' : 'close');
  }

  layout() {
    if (this._animator.isActivated() && this._state === OPEN_STATE) {
      this._animator.open();
    }
  }

  // enter collapse mode
  enterMode() {
    if (!this._active) {
      this._active = true;
      this._animator.activate();
      this.layout();
    }
  }

  // exit collapse mode
  exitMode() {
    if (this._active) {
      this._active = false;
      this._animator.inactivate();
    }
  }

  _isOpenOtherSideMenu() {
    return util.arrayFrom(this._element.parentElement.children).some(e => {
      return util.match(e, 'ons-splitter-side') && e !== this._element && e.isOpen();
    });
  }

  /**
   * @param {String} name - 'open' or 'close'
   * @param {Object} [options]
   * @param {Function} [options.callback]
   * @param {Boolean} [options.withoutAnimation]
   * @return {Promise} Resolves to the splitter side element
   */
  _executeAction(name, options = {}) {
    const FINAL_STATE = name === 'open' ? OPEN_STATE : CLOSED_STATE;

    if (!this._active || this._state === FINAL_STATE) {
      return Promise.resolve(this._element);
    }
    if (this._lock.isLocked()) {
      return Promise.reject('Splitter side is locked.');
    }
    if (name === 'open' && this._isOpenOtherSideMenu()) {
      return Promise.reject('Another menu is already open.');
    }
    if (this._element._emitEvent(`pre${name}`)) {
      return Promise.reject(`Canceled in pre${name} event.`);
    }

    const callback = options.callback;
    const unlock = this._lock.lock();
    const done = () => {
      this._state = FINAL_STATE;
      this.layout();
      unlock();
      this._element._emitEvent(`post${name}`);
      callback && callback();
    };

    if (options.withoutAnimation) {
      done();
      return Promise.resolve(this._element);
    }
    this._state = CHANGING_STATE;
    return new Promise(resolve => {
      this._animator[name](() => {
        done();
        resolve(this._element);
      });
    });
  }

  /**
   * @param {Object} [options]
   * @param {Function} [options.callback]
   * @param {Boolean} [options.withoutAnimation]
   * @return {Promise} Resolves to the splitter side element
   */
  open(options = {}) {
    return this._executeAction('open', options);
  }

  /**
   * @param {Object} [options]
   * @param {Function} [options.callback]
   * @param {Boolean} [options.withoutAnimation]
   * @return {Promise} Resolves to the splitter side element
   */
  close(options = {}) {
    return this._executeAction('close', options);
  }
}

const watchedAttributes = ['animation', 'width', 'side', 'collapse', 'swipeable', 'swipe-target-width', 'animation-options', 'open-threshold'];
const updateFunctionName = (name) => {
  return '_updateFor' + name.split('-').map((e) => e[0].toUpperCase() + e.slice(1)).join('') + 'Attribute';
};
/**
 * @element ons-splitter-side
 * @category control
 * @description
 *  [en]The "ons-splitter-side" element is used as a child element of "ons-splitter".[/en]
 *  [ja]ons-splitter-side要素は、ons-splitter要素の子要素として利用します。[/ja]
 * @codepen rOQOML
 * @seealso ons-splitter
 *  [en]ons-splitter component[/en]
 *  [ja]ons-splitterコンポーネント[/ja]
 * @seealso ons-splitter-content
 *  [en]ons-splitter-content component[/en]
 *  [ja]ons-splitter-contentコンポーネント[/ja]
 * @example
 * <ons-splitter>
 *   <ons-splitter-content>
 *     ...
 *   </ons-splitter-content>
 *
 *   <ons-splitter-side side="left" width="80%" collapse>
 *     ...
 *   </ons-splitter-side>
 * </ons-splitter>
 */
class SplitterSideElement extends BaseElement {

  /**
   * @event modechange
   * @description
   *   [en]Fired just after the component's mode changes.[/en]
   *   [ja]この要素のモードが変化した際に発火します。[/ja]
   * @param {Object} event
   *   [en]Event object.[/en]
   *   [ja]イベントオブジェクトです。[/ja]
   * @param {Object} event.side
   *   [en]Component object.[/en]
   *   [ja]コンポーネントのオブジェクト。[/ja]
   * @param {String} event.mode
   *   [en]Returns the current mode. Can be either "collapse" or "split".[/en]
   *   [ja]現在のモードを返します。[/ja]
   */

  /**
   * @event preopen
   * @description
   *   [en]Fired just before the sliding menu is opened.[/en]
   *   [ja]スライディングメニューが開く前に発火します。[/ja]
   * @param {Object} event
   *   [en]Event object.[/en]
   *   [ja]イベントオブジェクトです。[/ja]
   * @param {Function} event.cancel
   *   [en]Call to cancel opening sliding menu.[/en]
   *   [ja]スライディングメニューが開くのをキャンセルします。[/ja]
   * @param {Object} event.side
   *   [en]Component object.[/en]
   *   [ja]コンポーネントのオブジェクト。[/ja]
   */

  /**
   * @event postopen
   * @description
   *   [en]Fired just after the sliding menu is opened.[/en]
   *   [ja]スライディングメニューが開いた後に発火します。[/ja]
   * @param {Object} event
   *   [en]Event object.[/en]
   *   [ja]イベントオブジェクトです。[/ja]
   * @param {Object} event.side
   *   [en]Component object.[/en]
   *   [ja]コンポーネントのオブジェクト。[/ja]
   */

  /**
   * @event preclose
   * @description
   *   [en]Fired just before the sliding menu is closed.[/en]
   *   [ja]スライディングメニューが閉じる前に発火します。[/ja]
   * @param {Object} event
   *   [en]Event object.[/en]
   *   [ja]イベントオブジェクトです。[/ja]
   * @param {Object} event.side
   *   [en]Component object.[/en]
   *   [ja]コンポーネントのオブジェクト。[/ja]
   * @param {Function} event.cancel
   *   [en]Call to cancel opening sliding-menu.[/en]
   *   [ja]スライディングメニューが閉じるのをキャンセルします。[/ja]
   */

  /**
   * @event postclose
   * @description
   *   [en]Fired just after the sliding menu is closed.[/en]
   *   [ja]スライディングメニューが閉じた後に発火します。[/ja]
   * @param {Object} event
   *   [en]Event object.[/en]
   *   [ja]イベントオブジェクトです。[/ja]
   * @param {Object} event.side
   *   [en]Component object.[/en]
   *   [ja]コンポーネントのオブジェクト。[/ja]
   */

  /**
   * @attribute animation
   * @initonly
   * @type {String}
   * @description
   *  [en]Specify the animation. Use one of "overlay", and "default".[/en]
   *  [ja]アニメーションを指定します。"overlay", "default"のいずれかを指定できます。[/ja]
   */

  /**
   * @attribute animation-options
   * @type {Expression}
   * @description
   *  [en]Specify the animation's duration, timing and delay with an object literal. E.g. <code>{duration: 0.2, delay: 1, timing: 'ease-in'}</code>[/en]
   *  [ja]アニメーション時のduration, timing, delayをオブジェクトリテラルで指定します。e.g. <code>{duration: 0.2, delay: 1, timing: 'ease-in'}</code>[/ja]
   */

  /**
   * @attribute open-threshold
   * @type {Number}
   * @description
   *  [en]Specify how much the menu needs to be swiped before opening. A value between 0 and 1. Default is 0.3.[/en]
   *  [ja]どのくらいスワイプすればスライディングメニューを開くかどうかの割合を指定します。0から1の間の数値を指定します。スワイプの距離がここで指定した数値掛けるこの要素の幅よりも大きければ、スワイプが終わった時にこの要素を開きます。デフォルトは0.3です。[/ja]
   */

  /**
   * @attribute collapse
   * @type {String}
   * @description
   *   [en]
   *     Specify the collapse behavior. Valid values are "portrait", "landscape" or a media query.
   *     "portrait" or "landscape" means the view will collapse when device is in landscape or portrait orientation.
   *     If the value is a media query, the view will collapse when the media query is true.
   *     If the value is not defined, the view always be in "collapse" mode.
   *   [/en]
   *   [ja]
   *     左側のページを非表示にする条件を指定します。portrait, landscape、width #pxもしくはメディアクエリの指定が可能です。
   *     portraitもしくはlandscapeを指定すると、デバイスの画面が縦向きもしくは横向きになった時に適用されます。
   *     メディアクエリを指定すると、指定したクエリに適合している場合に適用されます。
   *     値に何も指定しない場合には、常にcollapseモードになります。
   *   [/ja]
   */

  /**
   * @attribute swipe-target-width
   * @type {String}
   * @description
   *   [en]The width of swipeable area calculated from the edge (in pixels). Use this to enable swipe only when the finger touch on the screen edge.[/en]
   *   [ja]スワイプの判定領域をピクセル単位で指定します。画面の端から指定した距離に達するとページが表示されます。[/ja]
   */

  /**
   * @attribute width
   * @type {String}
   * @description
   *   [en]Can be specified in either pixels or as a percentage, e.g. "90%" or "200px".[/en]
   *   [ja]この要素の横幅を指定します。pxと%での指定が可能です。eg. 90%, 200px[/ja]
   */

  /**
   * @attribute side
   * @type {String}
   * @description
   *   [en]Specify which side of the screen the ons-splitter-side element is located on. Possible values are "left" (default) and "right".[/en]
   *   [ja]この要素が左か右かを指定します。指定できる値は"left"か"right"のみです。[/ja]
   */

  /**
   * @attribute mode
   * @type {String}
   * @description
   *   [en]Current mode. Possible values are "collapse" or "split". This attribute is read only.[/en]
   *   [ja]現在のモードが設定されます。"collapse"もしくは"split"が指定されます。この属性は読み込み専用です。[/ja]
   */

  /**
   * @attribute page
   * @initonly
   * @type {String}
   * @description
   *   [en]The url of the menu page.[/en]
   *   [ja]ons-splitter-side要素に表示するページのURLを指定します。[/ja]
   */

  /**
   * @attribute swipeable
   * @type {Boolean}
   * @description
   *   [en]Whether to enable swipe interaction on collapse mode.[/en]
   *   [ja]collapseモード時にスワイプ操作を有効にする場合に指定します。[/ja]
   */

  get page() {
    return this._page;
  }

  get mode() {
    return this._mode;
  }

  /**
   * @method getCurrentMode
   * @signature getCurrentMode()
   * @return {String}
   *   [en]Get current mode. Possible values are "collapse" or "split".[/en]
   *   [ja]このons-splitter-side要素の現在のモードを返します。"split"かもしくは"collapse"のどちらかです。[/ja]
   */
  getCurrentMode() {
    return this._mode;
  }

  isOpen() {
    return this._collapseMethod('isOpen');
  }

  isSwipeable() {
    return this.hasAttribute('swipeable');
  }

  _collapseMethod(name, ...args) {
    return this._mode === COLLAPSE_MODE && this._collapseMode[name](...args);
  }

  createdCallback() {
    this._collapseStrategy = new CollapseDetection(this);
    this._animatorFactory = new AnimatorFactory({
      animators: window.OnsSplitterElement._animatorDict,
      baseClass: SplitterAnimator,
      baseClassName: 'SplitterAnimator',
      defaultAnimation: this.getAttribute('animation')
    });

    this._collapseMode = new CollapseMode(this);

    this._boundHandleGesture = (e) => this._collapseMethod('handleGesture', e);

    watchedAttributes.filter(e => e !== 'collapse').forEach(e => this[updateFunctionName(e)]());
  }

  _emitEvent(name) {
    if (name.slice(0, 3) !== 'pre') {
      return util.triggerElementEvent(this, name, {side: this});
    }
    let isCanceled = false;

    util.triggerElementEvent(this, name, {
      side: this,
      cancel: () => isCanceled = true
    });

    return isCanceled;
  }

  _updateForCollapseAttribute(value = this.getAttribute('collapse')) {
    if (value === null || value === 'split') {
      return this._updateMode(SPLIT_MODE);
    }
    if (value === '' || value === 'collapse') {
      return this._updateMode(COLLAPSE_MODE);
    }
    const strategy = new CollapseDetection(this, value);
    if (this._isAttached) {
      this._collapseStrategy.inactivate();
      strategy.activate();
    }

    this._collapseStrategy = strategy;
  }

  _updateMode(mode) {
    if (mode !== this._mode) {
      this._mode = mode;
      this._collapseMethod(mode === COLLAPSE_MODE ? 'enterMode' : 'exitMode');
      this.setAttribute('mode', mode);

      util.triggerElementEvent(this, 'modechange', {side: this, mode: mode});
    }
  }

  _updateForModeAttribute(mode = this.getAttribute('mode')) {
    this._updateMode(mode || SPLIT_MODE);
  }

  _updateForOpenThresholdAttribute(threshold = this.getAttribute('open-threshold')) {
    this._threshold = Math.max(0, Math.min(1, parseFloat(threshold) || 0.3));
  }

  _updateForSwipeableAttribute(swipeable = this.getAttribute('swipeable')) {
    if (this._gestureDetector) {
      const action = swipeable === null ? 'off' : 'on';
      this._gestureDetector[action]('dragstart dragleft dragright dragend', this._boundHandleGesture);
    }
  }

  _updateForSwipeTargetWidthAttribute(value = this.getAttribute('swipe-target-width')) {
    this._swipeTargetWidth = Math.max(0, parseInt(value) || 0);
  }

  _updateForWidthAttribute(width = this.getAttribute('width')) {
    this._width = /^\d+(px|%)$/.test(width) ? width : '80%';
    this.style.width = this._width;
    this._collapseMethod('layout');
  }

  _updateForSideAttribute(side = this.getAttribute('side')) {
    this._side = side === 'right' ? side : 'left';
    this._collapseMethod('layout');
  }

  _updateForAnimationAttribute() {
    this._updateAnimator();
  }

  _updateForAnimationOptionsAttribute(value = this.getAttribute('animation-options')) {
    // this._animationOptions = util.parseJSONObjectSafely(value, {});
    this._updateAnimator();
  }

  _updateAnimator(){
    const [oldAnimator, newAnimator] = [this._animator, this._initAnimator()];

    if (oldAnimator && oldAnimator.isActivated()) {
      oldAnimator.inactivate();
      newAnimator.activate();
    }
  }

  _initAnimator() {
    const animator = this._animatorFactory.newAnimator({
      animation: this.getAttribute('animation'),
      animationOptions: AnimatorFactory.parseAnimationOptionsString(this.getAttribute('animation-options'))
    });

    animator.activate = (oldActivate => {
      const content = util.findChild(this.parentElement, 'ons-splitter-content');
      const mask = util.findChild(this.parentElement, 'ons-splitter-mask');
      return oldActivate.bind(animator, content, this, mask);
    })(animator.activate);

    this._animator = animator;
    return animator;
  }


  /**
   * @method open
   * @signature open([options])
   * @param {Object} [options]
   *   [en]Parameter object.[/en]
   *   [ja]オプションを指定するオブジェクト。[/ja]
   * @param {Function} [options.callback]
   *   [en]This function will be called after the menu has been opened.[/en]
   *   [ja]メニューが開いた後に呼び出される関数オブジェクトを指定します。[/ja]
   * @description
   *   [en]Open menu in collapse mode.[/en]
   *   [ja]collapseモードになっているons-splitterside要素を開きます。[/ja]
   * @return {Promise}
   *   [en]Resolves to the splitter side element[/en]
   *   [ja][/ja]
   */
  open(options = {}) {
    return this._collapseMethod('open', options);
  }

  /**
   * @method close
   * @signature close([options])
   * @param {Object} [options]
   *   [en]Parameter object.[/en]
   *   [ja]オプションを指定するオブジェクト。[/ja]
   * @param {Function} [options.callback]
   *   [en]This function will be called after the menu has been closed.[/en]
   *   [ja]メニューが閉じた後に呼び出される関数オブジェクトを指定します。[/ja]
   * @description
   *   [en]Close menu in collapse mode.[/en]
   *   [ja]collapseモードになっているons-splitter-side要素を閉じます。[/ja]
   * @return {Promise}
   *   [en]Resolves to the splitter side element[/en]
   *   [ja][/ja]
   */
  close(options = {}) {
    return this._collapseMethod('close', options);
  }

  /**
   * @method load
   * @signature load(page, [options])
   * @param {String} page
   *   [en]Page URL. Can be either an HTML document or an <ons-template>.[/en]
   *   [ja]pageのURLか、ons-templateで宣言したテンプレートのid属性の値を指定します。[/ja]
   * @param {Object} [options]
   * @param {Function} [options.callback]
   * @description
   *   [en]Show the page specified in pageUrl in the right section[/en]
   *   [ja]指定したURLをメインページを読み込みます。[/ja]
   * @return {Promise}
   *   [en]Resolves to the new page element[/en]
   *   [ja][/ja]
   */
  load(page, options = {}) {
    this._page = page;
    const callback = options.callback;

    return internal.getPageHTMLAsync(page).then(html => new Promise(resolve => {
      rewritables.link(this, util.createFragment(html), options, fragment => {
        this._hide();

        this.innerHTML = '';
        this.appendChild(fragment);

        this._show();
        callback && callback();
        resolve(this.firstChild);
      });
    }));
  }

  /**
   * @param {Object} [options]
   */
  toggle(options = {}) {
    return this.isOpen() ? this.close(options) : this.open(options);
  }

  attributeChangedCallback(name, last, current) {
    if (watchedAttributes.indexOf(name) !== -1) {
      this[updateFunctionName(name)](current, last);
    }
  }

  attachedCallback() {
    this._isAttached = true;
    this._updateForCollapseAttribute();
    this._updateForWidthAttribute();

    if (!util.match(this.parentNode, 'ons-splitter')) {
      throw new Error('Parent must be an ons-splitter element.');
    }

    this._gestureDetector = new GestureDetector(this.parentElement, {dragMinDistance: 1});
    this._updateForSwipeableAttribute();

    if (this.hasAttribute('page')) {
      rewritables.ready(this, () => this.load(this.getAttribute('page')));
    }
  }

  detachedCallback() {
    this._isAttached = false;
    this._collapseStrategy.inactivate();

    this._gestureDetector.dispose();
    this._gestureDetector = null;
  }

  _show() {
    util.propagateAction(this, '_show');
  }

  _hide() {
    util.propagateAction(this, '_hide');
  }

  _destroy() {
    util.propagateAction(this, '_destroy');
    this.remove();
  }
}

window.OnsSplitterSideElement = document.registerElement('ons-splitter-side', {
  prototype: SplitterSideElement.prototype
});

window.OnsSplitterSideElement.rewritables = rewritables;

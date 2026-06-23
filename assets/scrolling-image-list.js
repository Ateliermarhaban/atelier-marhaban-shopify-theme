/**
 * Returns a function, that, when invoked, will only be triggered at most once during
 * a given window of time.
 * @param {Function} fn - Callback function.
 * @param {number} [wait=300] - Time window (in milliseconds).
 * @returns {Function}
 */
function throttle(fn, wait = 300) {
  let throttleTimeoutId = -1;
  let tick = false;

  return () => {
    clearTimeout(throttleTimeoutId);
    throttleTimeoutId = setTimeout(fn, wait);

    if (!tick) {
      fn.call();
      tick = true;
      setTimeout(() => {
        tick = false;
      }, wait);
    }
  };
}

if (!customElements.get('scrolling-image-list')) {
  class ScrollingImageList extends HTMLElement {
    constructor() {
      super();
      window.initLazyScript(this, this.init.bind(this));
    }

    init() {
      this.images = this.querySelectorAll('.scrolling-image-list__image');

      // Interactive elements are only required if there is more than one image
      if (this.images.length > 1) {
        this.contentColumn = this.querySelector('.scrolling-image-list__content-column');
        this.featureText = this.querySelector('.scrolling-image-list__content-column .feature-text-paired');

        const mq = window.matchMedia('(min-width: 768px)');
        this.addListeners(mq);
        mq.addEventListener('change', (event) => {
          this.removeListeners();
          this.addListeners(event);
        });
      }
      this.setAttribute('loaded', '');
    }

    /**
     * Add event listeners for this element.
     * @param {MediaQueryList|MediaQueryListEvent} mq - MediaQuery object determining flip between
     * carousel & scroll modes.
     */
    addListeners(mq) {
      if (mq.matches) {
        this.throttledHandleScroll = throttle(this.handleScroll.bind(this), 100);
        window.addEventListener('scroll', this.throttledHandleScroll);
        this.boundUpdatePositioning = this.updatePositioning.bind(this);
        window.addEventListener('scroll', this.boundUpdatePositioning);
        window.addEventListener('resize', this.boundUpdatePositioning);

        // After binding scroll events, run them
        this.throttledHandleScroll();
        this.boundUpdatePositioning();

        this.contentClickListeners = [];
        this.querySelectorAll('.scrolling-image-list__image').forEach((el) => {
          const oc = () => this.scrollToImage(el.dataset.index);
          this.contentClickListeners.push({ el, oc });
          el.addEventListener('click', oc);
        });

        // Keyboard tabbing
        this.delegatedKeydownHandler = theme.addDelegateEventListener(this, 'keydown', '.scrolling-image-list__image, .scrolling-image-list__content:not(.scrolling-image-list__content--mobile), .scrolling-image-list__content:not(.scrolling-image-list__content--mobile) a', this.handleKeydown.bind(this));
      } else {
        this.addEventListener('on:carousel-slider:select', this.handleSliderSelect.bind(this));
      }
    }

    removeListeners() {
      window.removeEventListener('scroll', this.throttledHandleScroll);
      window.removeEventListener('scroll', this.boundUpdatePositioning);
      window.removeEventListener('resize', this.boundUpdatePositioning);
      if (this.contentClickListeners) {
        for (let i = 0; i < this.contentClickListeners.length; i += 1) {
          this.contentClickListeners[i].el.removeEventListener('click', this.contentClickListeners[i].oc);
        }
      }
      this.removeEventListener('click', this.delegatedKeydownHandler);
    }

    /**
     * Handles throttled 'scroll' events on window.
     */
    handleScroll() {
      let closestIndex = 1;
      let closestDistance = Number.MAX_VALUE;

      this.images.forEach((el, index) => {
        const distance = ScrollingImageList.distanceFromViewportMiddle(el);
        if (distance < closestDistance) {
          closestIndex = index + 1;
          closestDistance = distance;
        }
      });

      this.dataset.currentIndex = closestIndex;
    }

    /**
     * Handles keydown on a selection of elements to aid with tabbing.
     * @param {Event} evt - Keydown event to handle.
     * @param {Element} el - Element this event was triggered on.
     */
    handleKeydown(evt, el) {
      if (evt.code !== 'Tab') return;

      if (el.classList.contains('scrolling-image-list__image')) {
        if (!evt.shiftKey) {
          evt.preventDefault();
          this.querySelector(`.scrolling-image-list__content:not(.scrolling-image-list__content--mobile)[data-index="${el.dataset.index}"]`).focus();
          return;
        }

        if (el.dataset.index !== '1') {
          evt.preventDefault();
          this.querySelector(`.scrolling-image-list__image[data-index="${parseInt(el.dataset.index, 10) - 1}"]`).focus();
          return;
        }

        return;
      }

      if (el.classList.contains('scrolling-image-list__content')) {
        if (evt.shiftKey) {
          evt.preventDefault();
          this.querySelector(`.scrolling-image-list__image[data-index="${el.dataset.index}"]`).focus();
          return;
        }

        if (el.nextElementSibling !== null) {
          evt.preventDefault();
          if (el.querySelector('a')) {
            el.querySelector('a').focus();
          } else {
            this.querySelector(`.scrolling-image-list__image[data-index="${parseInt(el.dataset.index, 10) + 1}"]`).focus();
          }
          return;
        }

        return;
      }

      if (el.tagName === 'A') {
        const contentContainer = el.closest('.scrolling-image-list__content');
        if (contentContainer.nextElementSibling !== null) {
          const lastA = [...contentContainer.querySelectorAll('a')].pop();

          if (lastA === el && !evt.shiftKey) {
            evt.preventDefault();
            this.querySelector(`.scrolling-image-list__image[data-index="${parseInt(contentContainer.dataset.index, 10) + 1}"]`).focus();
          }
        }
      }
    }

    /**
     * Set variables controlling the position of text content.
     */
    updatePositioning() {
      const containerBcr = this.contentColumn.getBoundingClientRect();
      const containerOffset = containerBcr.top + window.scrollY;
      const contentHeight = this.featureText.getBoundingClientRect().height;
      let bcr = this.images[0].getBoundingClientRect();
      const topImageMid = bcr.top + window.scrollY + bcr.height / 2;
      bcr = this.images[this.images.length - 1].getBoundingClientRect();
      const botImageMid = bcr.top + window.scrollY + bcr.height / 2;
      const windowMid = window.scrollY + window.innerHeight / 2;
      if (windowMid < topImageMid) {
        this.style.setProperty('--scrolling-image-list-content-offset-y', `${topImageMid - containerOffset - contentHeight / 2}px`);
        this.style.removeProperty('--scrolling-image-list-content-position');
        this.style.removeProperty('--scrolling-image-list-content-offset-x');
        this.style.removeProperty('--scrolling-image-list-content-width');
      } else if (windowMid > botImageMid) {
        this.style.setProperty('--scrolling-image-list-content-offset-y', `${botImageMid - containerOffset - contentHeight / 2}px`);
        this.style.removeProperty('--scrolling-image-list-content-position');
        this.style.removeProperty('--scrolling-image-list-content-offset-x');
        this.style.removeProperty('--scrolling-image-list-content-width');
      } else {
        this.style.setProperty('--scrolling-image-list-content-position', 'fixed');
        this.style.setProperty('--scrolling-image-list-content-offset-y', `${window.innerHeight / 2 - contentHeight / 2}px`);
        this.style.setProperty('--scrolling-image-list-content-offset-x', `${containerBcr.left}px`);
        this.style.setProperty('--scrolling-image-list-content-width', `${containerBcr.width}px`);
      }
    }

    /**
     * Handles mobile carousel select event.
     * @param {object} evt - Slider event.
     */
    handleSliderSelect(evt) {
      this.dataset.currentIndex = evt.detail.index + 1;
    }

    /**
     * Scroll to place a specific image in the middle of the viewport.
     * @param {number} index - Index of image to scroll to
     */
    scrollToImage(index) {
      const image = this.images[index - 1];
      window.scrollTo({
        left: 0,
        top: theme.getOffsetTopFromDoc(image) - (window.innerHeight - image.clientHeight) / 2,
        behavior: 'smooth'
      });
    }

    /**
     * Determine distance between middle of element and middle of viewport.
     * @param {Element} el - Element to check
     * @returns {number}
     */
    static distanceFromViewportMiddle(el) {
      const viewportMidY = window.scrollY + window.innerHeight / 2;
      const imageMidY = theme.getOffsetTopFromDoc(el) + el.clientHeight / 2;
      return Math.abs(viewportMidY - imageMidY);
    }
  }

  customElements.define('scrolling-image-list', ScrollingImageList);
}

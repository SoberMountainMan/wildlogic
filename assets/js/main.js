/*
	Strata by HTML5 UP
	html5up.net | @ajlkn
	Free for personal and commercial use under the CCA 3.0 license (html5up.net/license)
*/

(function($) {

	var $window = $(window),
		$body = $('body'),
		$header = $('#header'),
		$footer = $('#footer'),
		$main = $('#main'),
		settings = {

			// Parallax background effect?
				parallax: true,

			// Parallax factor (lower = more intense, higher = less intense).
				parallaxFactor: 20

		};

	// Breakpoints.
		breakpoints({
			xlarge:  [ '1281px',  '1800px' ],
			large:   [ '981px',   '1280px' ],
			medium:  [ '737px',   '980px'  ],
			small:   [ '481px',   '736px'  ],
			xsmall:  [ null,      '480px'  ],
		});

	// Play initial animations on page load.
		$window.on('load', function() {
			window.setTimeout(function() {
				$body.removeClass('is-preload');
			}, 100);
		});

	// Touch?
		if (browser.mobile) {

			// Turn on touch mode.
				$body.addClass('is-touch');

			// Height fix (mostly for iOS).
				window.setTimeout(function() {
					$window.scrollTop($window.scrollTop() + 1);
				}, 0);

		}

	// Footer.
		breakpoints.on('<=medium', function() {
			$footer.insertAfter($main);
		});

		breakpoints.on('>medium', function() {
			$footer.appendTo($header);
		});

	// Header.

		// Parallax background.

			// Disable parallax on IE (smooth scrolling is jerky), and on mobile platforms (= better performance).
				if (browser.name == 'ie'
				||	browser.mobile)
					settings.parallax = false;

			if (settings.parallax) {

				// Largest upward shift available before 'cover' runs out of
				// image at the panel's bottom edge (per background image).
					var bgURL = null,
						bgLimit = null;

					function bgMaxShift() {
						var el = $header[0],
							parts = getComputedStyle(el).backgroundImage.match(/url\(["']?([^"')]+)["']?\)/g) || [];
						if (!parts.length)
							return 0;
						var url = parts[parts.length - 1].replace(/^url\(["']?/, '').replace(/["']?\)$/, '');
						if (url !== bgURL) {
							bgURL = url;
							bgLimit = null;
							var img = new Image();
							img.onload = function() {
								var r = el.getBoundingClientRect(),
									s = Math.max(r.width / img.width, r.height / img.height);
								bgLimit = Math.max(0, img.height * s - r.height);
								$window.triggerHandler('scroll');
							};
							img.src = url;
						}
						return bgLimit === null ? Infinity : bgLimit;
					}

					$window.on('resize.strata_bgmeasure', function() {
						bgURL = null;
					});

				breakpoints.on('<=medium', function() {

					$window.off('scroll.strata_parallax');
					$header.css('background-position', '');

				});

				breakpoints.on('>medium', function() {

					$header.css('background-position', 'left 0px');

					$window.on('scroll.strata_parallax', function() {
						var y = -1 * (parseInt($window.scrollTop()) / settings.parallaxFactor),
							max = bgMaxShift();
						if (-y > max)
							y = -max;
						$header.css('background-position', 'left ' + y + 'px');
					});

				});

				$window.on('load', function() {
					$window.triggerHandler('scroll');
				});

			}

	// Main Sections: Two.

		// Lightbox gallery.
			$window.on('load', function() {

				$('#two').poptrox({
					caption: function($a) { return $a.next('h3').text(); },
					overlayColor: '#2c2c2c',
					overlayOpacity: 0.85,
					popupCloserText: '',
					popupLoaderText: '',
					selector: '.work-item a.image',
					usePopupCaption: true,
					usePopupDefaultStyling: false,
					usePopupEasyClose: false,
					usePopupNav: true,
					windowMargin: (breakpoints.active('<=small') ? 0 : 50)
				});

			});

})(jQuery);
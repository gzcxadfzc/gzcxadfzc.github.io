/**
 * Menu
 */
$("a.menu-icon").on("click", function(event) {
  var w = $(".menu");

  w.css({
    display: (w.css("display") === "none")
      ? "block"
      : "none"
  });
});

/**
 * Footer year
 */
$(document).ready(function() {
  $("#year").text(new Date().getFullYear());
});

/**
 * Footer email
 */
$(document).ready(function() {
  $(".email-link-cloaked").on("click", function(event) {
    const _link = event.target;

    const _user = reverseString(_link.getAttribute("data-resu"));
    const _domain = reverseString(_link.getAttribute("data-eman-niamod"));
    const _tld = reverseString(_link.getAttribute("data-dlt-niamod"));

    window.location.href = `mailto:${_user}@${_domain}.${_tld}`;
  });
});

/**
 * Reverses a string
 */
function reverseString(str) {
  return str.split("").reverse().join("");
}

/**
 * Right-side floating table of contents, auto-built from the post's own
 * headings (kramdown already gives each heading a stable id).
 */
function buildToc() {
  var content = document.querySelector(".post-content");
  if (!content) return;

  var headings = content.querySelectorAll("h1, h2, h3, h4, h5, h6");
  if (headings.length < 1) return;

  var nav = document.createElement("nav");
  nav.className = "post-toc";

  var list = document.createElement("ol");

  headings.forEach(function (heading) {
    if (!heading.id) return;

    var level = parseInt(heading.tagName.substring(1), 10);
    var item = document.createElement("li");
    item.className = "post-toc-h" + level;

    var link = document.createElement("a");
    link.href = "#" + heading.id;
    link.textContent = heading.textContent;

    item.appendChild(link);
    list.appendChild(item);
  });

  nav.appendChild(list);
  document.body.appendChild(nav);

  var links = nav.querySelectorAll("a");
  var observer = new IntersectionObserver(
    function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;

        var active = nav.querySelector('a[href="#' + entry.target.id + '"]');
        if (!active) return;

        links.forEach(function (l) { l.classList.remove("active"); });
        active.classList.add("active");
      });
    },
    { rootMargin: "-20% 0px -70% 0px" }
  );

  headings.forEach(function (heading) {
    if (heading.id) observer.observe(heading);
  });
}

$(document).ready(buildToc);

/**
 * Moves WeChat widget
 */
function moveWidget(event) {
  var w = $("#wechat-widget");

  w.css({
    left: event.pageX - 25,
    top: event.pageY - w.height() - 60
  });
}

$("a#wechat-link").on("mouseenter", function(event) {
  $("#wechat-widget").css({ display: "block" });

  moveWidget(event);
});

$("a#wechat-link").on("mousemove", function(event) {
  moveWidget(event);
});

$("a#wechat-link").on("mouseleave", function(event) {
  $("#wechat-widget").css({ display: "none" });
});

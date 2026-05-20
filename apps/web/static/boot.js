(function () {
  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var script = document.createElement("script");
      script.src = src;
      script.onload = resolve;
      script.onerror = function () {
        reject(new Error("Failed to load " + src));
      };
      document.body.appendChild(script);
    });
  }

  loadScript("/vendor/react.development.js")
    .then(function () {
      return loadScript("/vendor/react-dom.development.js");
    })
    .then(function () {
      return loadScript("/app.js");
    })
    .catch(function (err) {
      document.getElementById("app").innerHTML = "<main style=\"padding:32px;font-family:sans-serif;color:#202033\"><h1>ScopeGuard failed to load</h1><p>" + err.message + "</p></main>";
    });
})();

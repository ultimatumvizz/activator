/*
 Copyright (C) 2014 Typesafe, Inc <http://typesafe.com>
 */
define([
  'commons/websocket',
  'text!./working.html'
], function(
  websocket,
  tpl
) {

  var requestAnimationFrame = window.requestAnimationFrame || window.webkitRequestAnimationFrame || window.mozRequestAnimationFrame || window.msRequestAnimationFrame || window.oRequestAnimationFrame;

  return {
    render: function() {
      var dom = ko.bindhtml(tpl, {});
      var logs = $("#loading-logs", dom);
      var wrapper = $("article", dom)[0];

      websocket.subscribe({type: "sbt", subType: "CoreLogEvent"}).fork().each(function(message) {
        requestAnimationFrame(function() {
          logs.append($("<li/>").html(message.event.entry.message).attr("data-type", message.event.entry.level));
          wrapper.scrollTop = 99999;
        });
      });

      websocket.subscribe({ response: String }).fork().each(function(message) {
        switch(message.response) {
          case 'Status':
            requestAnimationFrame(function() {
              logs.append($("<li/>").html(message.info).attr("data-type", "info"));
              logs[0].scrollTop = 99999;
            });
            break;
          case 'BadRequest':
            // TODO - Do better than an alert!
            window.alert('Unable to perform request: ' + message.errors.join(' \n'));
            $('#working, #open, #new').toggle();
            break;
          case 'RedirectToApplication':
            // NOTE - Comment this out if you want to debug showing logs!
            window.location.href = window.location.href.replace('home', 'app/'+message.appId+'/');
            break;
        }
      });

      return dom;
    }
  }

})

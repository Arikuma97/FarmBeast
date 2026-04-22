// ==UserScript==
// @name         FarmGod (Optimized)
// @namespace    https://github.com/yourname/farmgod
// @version      2.0.0
// @description  Efficient farming planner for Tribal Wars
// @author       Warre (optimized)
// @match        https://*.tribalwars.*/game.php*
// @grant        none
// ==/UserScript==

(() => {
  'use strict';


  /**** Namespace ****/
  window.FarmGod = {};

  /**** Core Library (Optimized) ****/
  window.FarmGod.Library = (function () {
    // ---------- twLib (Queue Manager) ----------
    if (typeof window.twLib === 'undefined') {
      window.twLib = {
        queues: null,
        init: function () {
          if (this.queues === null) {
            this.queues = this.queueLib.createQueues(5);
          }
        },
        queueLib: {
          maxAttempts: 3,
          Item: function (action, arg, promise = null) {
            this.action = action;
            this.arguments = arg;
            this.promise = promise;
            this.attempts = 0;
          },
          Queue: function () {
            this.list = [];
            this.working = false;
            this.length = 0;

            this.doNext = function () {
              const item = this.dequeue();
              const self = this;

              if (item.action === 'openWindow') {
                window.open(...item.arguments).addEventListener('DOMContentLoaded', () => self.start());
              } else {
                $[item.action](...item.arguments)
                  .done(function () {
                    item.promise.resolve.apply(null, arguments);
                    self.start();
                  })
                  .fail(function () {
                    item.attempts += 1;
                    if (item.attempts < twLib.queueLib.maxAttempts) {
                      self.enqueue(item, true);
                    } else {
                      item.promise.reject.apply(null, arguments);
                    }
                    self.start();
                  });
              }
            };

            this.start = function () {
              if (this.length) {
                this.working = true;
                this.doNext();
              } else {
                this.working = false;
              }
            };

            this.dequeue = function () {
              this.length -= 1;
              return this.list.shift();
            };

            this.enqueue = function (item, front = false) {
              front ? this.list.unshift(item) : this.list.push(item);
              this.length += 1;
              if (!this.working) this.start();
            };
          },
          createQueues: function (amount) {
            return Array.from({ length: amount }, () => new twLib.queueLib.Queue());
          },
          addItem: function (item) {
            const lengths = twLib.queues.map(q => q.length);
            const leastBusy = lengths.indexOf(Math.min(...lengths));
            twLib.queues[leastBusy].enqueue(item);
          },
          orchestrator: function (type, arg) {
            const promise = $.Deferred();
            const item = new twLib.queueLib.Item(type, arg, promise);
            twLib.queueLib.addItem(item);
            return promise;
          },
        },
        ajax: function () { return twLib.queueLib.orchestrator('ajax', arguments); },
        get: function () { return twLib.queueLib.orchestrator('get', arguments); },
        post: function () { return twLib.queueLib.orchestrator('post', arguments); },
        openWindow: function () {
          const item = new twLib.queueLib.Item('openWindow', arguments);
          twLib.queueLib.addItem(item);
        },
      };
      twLib.init();
    }

    // ---------- Caches ----------
    const distanceCache = new Map();      // key: "x1|y1->x2|y2" -> distance
    let unitSpeedsCache = null;           // fetched once

    // ---------- Unit Speeds (fetched once) ----------
    const fetchUnitSpeeds = function () {
      if (unitSpeedsCache) return $.Deferred().resolve(unitSpeedsCache).promise();
      const deferred = $.Deferred();
      $.get('/interface.php?func=get_unit_info').then(xml => {
        const speeds = {};
        $(xml).find('config').children().each((i, el) => {
          const unit = $(el).prop('nodeName');
          speeds[unit] = parseFloat($(el).find('speed').text());
        });
        unitSpeedsCache = speeds;
        localStorage.setItem('FarmGod_unitSpeeds', JSON.stringify(speeds));
        deferred.resolve(speeds);
      }).fail(() => {
        // fallback to localStorage
        const stored = localStorage.getItem('FarmGod_unitSpeeds');
        unitSpeedsCache = stored ? JSON.parse(stored) : {};
        deferred.resolve(unitSpeedsCache);
      });
      return deferred.promise();
    };

    const getUnitSpeeds = function () {
      return unitSpeedsCache || JSON.parse(localStorage.getItem('FarmGod_unitSpeeds')) || false;
    };

    // ---------- Pagination Helpers ----------
    const determineNextPage = function (page, $html) {
      const villageLength = $html.find('#scavenge_mass_screen').length > 0
        ? $html.find('tr[id*="scavenge_village"]').length
        : $html.find('tr.row_a, tr.row_ax, tr.row_b, tr.row_bx').length;
      const navSelect = $html.find('.paged-nav-item').first().closest('td').find('select').first();

      let navLength;
      if ($html.find('#am_widget_Farm').length > 0) {
        const navItems = $('#plunder_list_nav').first().find('a.paged-nav-item, strong.paged-nav-item');
        const lastPageText = navItems[navItems.length - 1]?.textContent || '0';
        navLength = parseInt(lastPageText.replace(/\D/g, '')) - 1;
      } else if (navSelect.length > 0) {
        navLength = navSelect.find('option').length - 1;
      } else {
        navLength = $html.find('.paged-nav-item').not('[href*="page=-1"]').length;
      }

      const pageSize = $('#mobileHeader').length > 0 ? 10 : parseInt($html.find('input[name="page_size"]').val());

      if (page === -1 && villageLength === 1000) {
        return Math.floor(1000 / pageSize);
      } else if (page < navLength) {
        return page + 1;
      }
      return false;
    };

    const processPage = function (url, page, wrapFn) {
      const pageParam = url.includes('am_farm') ? `&Farm_page=${page}` : `&page=${page}`;
      return twLib.ajax({ url: url + pageParam }).then(html => wrapFn(page, $(html)));
    };

    const processAllPages = function (url, processorFn) {
      const startPage = (url.includes('am_farm') || url.includes('scavenge_mass')) ? 0 : -1;
      const wrapFn = function (page, $html) {
        const next = determineNextPage(page, $html);
        if (next) {
          processorFn($html);
          return processPage(url, next, wrapFn);
        } else {
          return processorFn($html);
        }
      };
      return processPage(url, startPage, wrapFn);
    };

    // ---------- Distance Calculation with Cache ----------
    const getDistance = function (originCoord, targetCoord) {
      const key = `${originCoord}->${targetCoord}`;
      if (distanceCache.has(key)) return distanceCache.get(key);

      const [ox, oy] = originCoord.split('|').map(Number);
      const [tx, ty] = targetCoord.split('|').map(Number);
      const dist = Math.hypot(tx - ox, ty - oy);
      distanceCache.set(key, dist);
      return dist;
    };

    // Bounding box pre-filter: returns true if target could be within maxDist
    const isWithinBoundingBox = (originCoord, targetCoord, maxDist) => {
      const [ox, oy] = originCoord.split('|').map(Number);
      const [tx, ty] = targetCoord.split('|').map(Number);
      return Math.abs(tx - ox) <= maxDist && Math.abs(ty - oy) <= maxDist;
    };

    // ---------- Array Subtraction ----------
    const subtractArrays = (array1, array2) => {
      const result = new Array(array1.length);
      for (let i = 0; i < array1.length; i++) {
        result[i] = array1[i] - array2[i];
        if (result[i] < 0) return false;
      }
      return result;
    };

    // ---------- Time Utilities ----------
    const getCurrentServerTime = function () {
      const serverTimeText = $('#serverTime').closest('p').text();
      const [hour, min, sec, day, month, year] = serverTimeText.match(/\d+/g).map(Number);
      return new Date(year, month - 1, day, hour, min, sec).getTime();
    };

    const timestampFromString = function (timestr) {
      const d = $('#serverDate').text().split('/').map(x => +x);
      const todayRegex = new RegExp(window.lang['aea2b0aa9ae1534226518faaefffdaad'].replace('%s', '([\\d+|:]+)'));
      const tomorrowRegex = new RegExp(window.lang['57d28d1b211fddbb7a499ead5bf23079'].replace('%s', '([\\d+|:]+)'));
      const laterRegex = new RegExp(window.lang['0cb274c906d622fa8ce524bcfbb7552d'].replace('%1', '([\\d+|\\.]+)').replace('%2', '([\\d+|:]+)'));

      let t, date;
      if (todayRegex.test(timestr)) {
        t = RegExp.$1.split(':').map(Number);
        date = new Date(d[2], d[1] - 1, d[0], t[0], t[1], t[2] || 0);
      } else if (tomorrowRegex.test(timestr)) {
        t = RegExp.$1.split(':').map(Number);
        date = new Date(d[2], d[1] - 1, d[0] + 1, t[0], t[1], t[2] || 0);
      } else if (laterRegex.test(timestr)) {
        const datePart = (RegExp.$1 + d[2]).split('.').map(Number);
        t = RegExp.$2.split(':').map(Number);
        date = new Date(datePart[2], datePart[1] - 1, datePart[0], t[0], t[1], t[2] || 0);
      } else {
        return Date.now(); // fallback
      }
      return date.getTime();
    };

    // ---------- Helper to parse coordinates (non-prototype) ----------
    const extractCoord = (str) => {
      const match = str.match(/\d{1,3}\|\d{1,3}/);
      return match ? match[0] : null;
    };

    const coordToObject = (coord) => {
      const [x, y] = coord.split('|').map(Number);
      return { x, y };
    };

    // ---------- Public API ----------
    return {
      fetchUnitSpeeds,
      getUnitSpeeds,
      processPage,
      processAllPages,
      getDistance,
      isWithinBoundingBox,
      subtractArrays,
      getCurrentServerTime,
      timestampFromString,
      extractCoord,
      coordToObject,
      clearDistanceCache: () => distanceCache.clear(),
    };
  })();

  /**** Translation Module (unchanged) ****/
  window.FarmGod.Translation = (function () {
    const msg = {
      nl_NL: {
        missingFeatures: 'Script vereist een premium account en farm assistent!',
        options: {
          title: 'FarmGod Opties',
          warning: '<b>Waarschuwingen:</b><br>- Zorg dat A is ingesteld als je standaard microfarm en B als een grotere microfarm<br>- Zorg dat de farm filters correct zijn ingesteld voor je het script gebruikt',
          filterImage: 'https://higamy.github.io/TW/Scripts/Assets/farmGodFilters.png',
          group: 'Uit welke groep moet er gefarmd worden:',
          distance: 'Maximaal aantal velden dat farms mogen lopen:',
          time: 'Hoe veel tijd in minuten moet er tussen farms zitten:',
          losses: 'Verstuur farm naar dorpen met gedeeltelijke verliezen:',
          maxloot: 'Verstuur een B farm als de buit vorige keer vol was:',
          newbarbs: 'Voeg nieuwe barbarendorpen toe om te farmen:',
          button: 'Plan farms',
        },
        table: {
          noFarmsPlanned: 'Er kunnen met de opgegeven instellingen geen farms verstuurd worden.',
          origin: 'Oorsprong',
          target: 'Doel',
          fields: 'Velden',
          farm: 'Farm',
          goTo: 'Ga naar',
        },
        messages: {
          villageChanged: 'Succesvol van dorp veranderd!',
          villageError: 'Alle farms voor het huidige dorp zijn reeds verstuurd!',
          sendError: 'Error: farm niet verstuurd!',
        },
      },
      int: {
        missingFeatures: 'Script requires a premium account and loot assistent!',
        options: {
          title: 'FarmGod Options',
          warning: '<b>Warning:</b><br>- Make sure A is set as your default microfarm and B as a larger microfarm<br>- Make sure the farm filters are set correctly before using the script',
          filterImage: 'https://higamy.github.io/TW/Scripts/Assets/farmGodFilters.png',
          group: 'Send farms from group:',
          distance: 'Maximum fields for farms:',
          time: 'How much time in minutes should there be between farms:',
          losses: 'Send farm to villages with partial losses:',
          maxloot: 'Send a B farm if the last loot was full:',
          newbarbs: 'Add new barbs te farm:',
          button: 'Plan farms',
        },
        table: {
          noFarmsPlanned: 'No farms can be sent with the specified settings.',
          origin: 'Origin',
          target: 'Target',
          fields: 'fields',
          farm: 'Farm',
          goTo: 'Go to',
        },
        messages: {
          villageChanged: 'Successfully changed village!',
          villageError: 'All farms for the current village have been sent!',
          sendError: 'Error: farm not send!',
        },
      },
    };

    const get = function () {
      return msg[game_data.locale] || msg.int;
    };

    return { get };
  })();

  /**** Main Module (Optimized) ****/
  window.FarmGod.Main = (function (lib, t) {
    let curVillage = null;
    let farmBusy = false;
    let unitSpeedsPromise = null;

    // ---------- Initialization ----------
    const init = function () {
      if (!game_data.features.Premium.active || !game_data.features.FarmAssistent.active) {
        UI.ErrorMessage(t.missingFeatures);
        return;
      }

      if (game_data.screen !== 'am_farm') {
        location.href = game_data.link_base_pure + 'am_farm';
        return;
      }

      // Prefetch unit speeds early
      unitSpeedsPromise = lib.fetchUnitSpeeds();

      buildOptions().then(html => {
        Dialog.show('FarmGod', html);
        $('.optionButton').off('click').on('click', onOptionsConfirm);
        document.querySelector('.optionButton')?.focus();
      });
    };

    // ---------- Event Handlers ----------
    const bindEventHandlers = function () {
      $('.farmGod_icon').off('click').on('click', function () {
        if (game_data.market !== 'nl' || $(this).data('origin') == curVillage) {
          sendFarm($(this));
        } else {
          UI.ErrorMessage(t.messages.villageError);
        }
      });

      $(document).off('keydown').on('keydown', event => {
        if ((event.keyCode || event.which) === 13) {
          $('.farmGod_icon').first().trigger('click');
        }
      });

      $('.switchVillage').off('click').on('click', function () {
        curVillage = $(this).data('id');
        UI.SuccessMessage(t.messages.villageChanged);
        $(this).closest('tr').remove();
      });
    };

    const onOptionsConfirm = function () {
      const options = {
        group: parseInt($('.optionGroup').val()),
        distance: parseFloat($('.optionDistance').val()),
        time: parseFloat($('.optionTime').val()),
        losses: $('.optionLosses').prop('checked'),
        maxloot: $('.optionMaxloot').prop('checked'),
        newbarbs: $('.optionNewbarbs').prop('checked') || false,
      };
      localStorage.setItem('farmGod_options', JSON.stringify(options));

      $('.optionsContent').html(UI.Throbber[0].outerHTML + '<br><br>');
      getData(options).then(data => {
        Dialog.close();
        const plan = createPlanning(options, data);
        $('.farmGodContent').remove();
        $('#am_widget_Farm').first().before(buildTable(plan.farms));
        bindEventHandlers();
        UI.InitProgressBars();
        UI.updateProgressBar($('#FarmGodProgessbar'), 0, plan.counter);
        $('#FarmGodProgessbar').data({ current: 0, max: plan.counter });
      });
    };

    // ---------- Build Options Dialog ----------
    const buildOptions = function () {
      const stored = JSON.parse(localStorage.getItem('farmGod_options')) || {
        optionGroup: 0,
        optionDistance: 25,
        optionTime: 10,
        optionLosses: false,
        optionMaxloot: true,
        optionNewbarbs: true,
      };
      const checkboxSettings = [false, true, true, true, false];
      const checkboxError = $('#plunder_list_filters').find('input[type="checkbox"]')
        .map((i, el) => $(el).prop('checked') !== checkboxSettings[i]).get().includes(true);

      const $templateRows = $('form[action*="action=edit_all"]').find('input[type="hidden"][name*="template"]').closest('tr');
      const templateError = parseFloat($templateRows.first().find('td').last().text()) >=
                            parseFloat($templateRows.last().find('td').last().text());

      return buildGroupSelect(stored.optionGroup).then(groupSelect => {
        return `<style>#popup_box_FarmGod{text-align:center;width:550px;}</style>
                <h3>${t.options.title}</h3><br><div class="optionsContent">
                ${checkboxError || templateError ? `<div class="info_box" style="line-height:15px;font-size:10px;text-align:left;"><p style="margin:0 5px;">${t.options.warning}<br><img src="${t.options.filterImage}" style="width:100%;"></p></div><br>` : ''}
                <div style="width:90%;margin:auto;background:url('graphic/index/main_bg.jpg') 100% 0% #E3D5B3;border:1px solid #7D510F;border-collapse:separate;border-spacing:0;"><table class="vis" style="width:100%;text-align:left;font-size:11px;">
                  <tr><td>${t.options.group}</td><td>${groupSelect}</td></tr>
                  <tr><td>${t.options.distance}</td><td><input type="text" size="5" class="optionDistance" value="${stored.optionDistance}"></td></tr>
                  <tr><td>${t.options.time}</td><td><input type="text" size="5" class="optionTime" value="${stored.optionTime}"></td></tr>
                  <tr><td>${t.options.losses}</td><td><input type="checkbox" class="optionLosses" ${stored.optionLosses ? 'checked' : ''}></td></tr>
                  <tr><td>${t.options.maxloot}</td><td><input type="checkbox" class="optionMaxloot" ${stored.optionMaxloot ? 'checked' : ''}></td></tr>
                  ${game_data.market === 'nl' ? `<tr><td>${t.options.newbarbs}</td><td><input type="checkbox" class="optionNewbarbs" ${stored.optionNewbarbs ? 'checked' : ''}></td></tr>` : ''}
                </table></div><br><input type="button" class="btn optionButton" value="${t.options.button}"></div>`;
      });
    };

    const buildGroupSelect = function (selectedId) {
      return $.get(TribalWars.buildURL('GET', 'groups', { ajax: 'load_group_menu' })).then(groups => {
        let html = `<select class="optionGroup">`;
        groups.result.forEach(val => {
          if (val.type === 'separator') {
            html += `<option disabled/>`;
          } else {
            html += `<option value="${val.group_id}" ${val.group_id == selectedId ? 'selected' : ''}>${val.name}</option>`;
          }
        });
        html += `</select>`;
        return html;
      });
    };

    // ---------- Build Result Table ----------
    const buildTable = function (plan) {
      let html = `<div class="vis farmGodContent"><h4>FarmGod</h4><table class="vis" width="100%">
                  <tr><div id="FarmGodProgessbar" class="progress-bar live-progress-bar progress-bar-alive" style="width:98%;margin:5px auto;"><div style="background: rgb(146, 194, 0);"></div><span class="label" style="margin-top:0;"></span></div></tr>
                  <tr><th style="text-align:center;">${t.table.origin}</th><th style="text-align:center;">${t.table.target}</th><th style="text-align:center;">${t.table.fields}</th><th style="text-align:center;">${t.table.farm}</th></tr>`;

      if (!$.isEmptyObject(plan)) {
        for (const originCoord in plan) {
          if (game_data.market === 'nl') {
            const first = plan[originCoord][0];
            html += `<tr><td colspan="4" style="background:#e7d098;"><input type="button" class="btn switchVillage" data-id="${first.origin.id}" value="${t.table.goTo} ${first.origin.name} (${first.origin.coord})" style="float:right;"></td></tr>`;
          }
          plan[originCoord].forEach((val, i) => {
            html += `<tr class="farmRow row_${i % 2 ? 'b' : 'a'}">
                      <td style="text-align:center;"><a href="${game_data.link_base_pure}info_village&id=${val.origin.id}">${val.origin.name} (${val.origin.coord})</a></td>
                      <td style="text-align:center;"><a href="${game_data.link_base_pure}info_village&id=${val.target.id}">${val.target.coord}</a></td>
                      <td style="text-align:center;">${val.fields.toFixed(2)}</td>
                      <td style="text-align:center;"><a href="#" data-origin="${val.origin.id}" data-target="${val.target.id}" data-template="${val.template.id}" class="farmGod_icon farm_icon farm_icon_${val.template.name}" style="margin:auto;"></a></td>
                    </tr>`;
          });
        }
      } else {
        html += `<tr><td colspan="4" style="text-align:center;">${t.table.noFarmsPlanned}</td></tr>`;
      }
      html += `</table></div>`;
      return html;
    };

    // ---------- Data Gathering (Parallel & Optimized) ----------
    const getData = function (options) {
      const data = {
        villages: {},
        commands: {},        // key: coord -> lastArrivalTimestamp (seconds)
        farms: { templates: {}, farms: {} },
      };
      const skipUnits = ['ram', 'catapult', 'knight', 'snob', 'militia'];

      // Wait for unit speeds
      return unitSpeedsPromise.then(() => {
        const unitSpeeds = lib.getUnitSpeeds();

        // Processors
        const villagesProcessor = ($html) => {
          const mobile = $('#mobileHeader').length > 0;
          if (mobile) {
            $html.find('.overview-container > div').each((i, el) => {
              try {
                const $el = $(el);
                const villageId = $el.find('.quickedit-vn').data('id');
                const name = $el.find('.quickedit-label').attr('data-text');
                const coord = lib.extractCoord($el.find('.quickedit-label').text());
                if (!coord) return;

                const units = new Array(game_data.units.length).fill(0);
                $el.find('.overview-units-row > div.unit-row-item').each((_, unitEl) => {
                  const img = $(unitEl).find('img');
                  const span = $(unitEl).find('span.unit-row-name');
                  if (img.length && span.length) {
                    const unitType = img.attr('src').split('unit_')[1].replace(/@2x\.webp|\.webp|\.png/g, '');
                    const value = parseInt(span.text()) || 0;
                    const idx = game_data.units.indexOf(unitType);
                    if (idx !== -1) units[idx] = value;
                  }
                });
                const filtered = units.filter((_, idx) => !skipUnits.includes(game_data.units[idx]));
                data.villages[coord] = { name, id: villageId, units: filtered };
              } catch (e) { console.warn('Village parse error:', e); }
            });
          } else {
            $html.find('#combined_table .row_a, #combined_table .row_b').filter((i, el) => $(el).find('.bonus_icon_33').length === 0).each((i, el) => {
              const $el = $(el);
              const $label = $el.find('.quickedit-label').first();
              const coord = lib.extractCoord($label.text());
              if (!coord) return;

              const units = $el.find('.unit-item').map((idx, elem) => {
                if (skipUnits.includes(game_data.units[idx])) return null;
                return parseFloat($(elem).text()) || 0;
              }).get().filter(v => v !== null);

              data.villages[coord] = {
                name: $label.data('text'),
                id: parseInt($el.find('.quickedit-vn').first().data('id')),
                units,
              };
            });
          }
          return data;
        };

        const commandsProcessor = ($html) => {
          $html.find('#commands_table .row_a, #commands_table .row_ax, #commands_table .row_b, #commands_table .row_bx').each((i, el) => {
            const $el = $(el);
            const coord = lib.extractCoord($el.find('.quickedit-label').first().text());
            if (!coord) return;
            const arrival = Math.round(lib.timestampFromString($el.find('td').eq(2).text().trim()) / 1000);
            // Keep only the latest arrival (most relevant for cooldown)
            if (!data.commands[coord] || arrival > data.commands[coord]) {
              data.commands[coord] = arrival;
            }
          });
          return data;
        };

        const farmProcessor = ($html) => {
          if ($.isEmptyObject(data.farms.templates)) {
            $html.find('form[action*="action=edit_all"]').find('input[type="hidden"][name*="template"]').closest('tr').each((i, el) => {
              const $el = $(el);
              const templateName = $el.prev('tr').find('a.farm_icon').first().attr('class').match(/farm_icon_(.*)\s/)?.[1];
              if (!templateName) return;

              const templateId = parseFloat($el.find('input[type="hidden"][name*="[id]"]').first().val());
              const unitInputs = $el.find('input[type="text"], input[type="number"]');
              const units = unitInputs.map((idx, inp) => parseFloat($(inp).val()) || 0).get();
              const speed = Math.max(...unitInputs.map((idx, inp) => {
                const val = parseFloat($(inp).val()) || 0;
                if (val === 0) return 0;
                const unitName = $(inp).attr('name').trim().split('[')[0];
                return unitSpeeds[unitName] || 0;
              }).get());

              data.farms.templates[templateName] = { id: templateId, units, speed };
            });
          }

          $html.find('#plunder_list tr[id^="village_"]').each((i, el) => {
            const $el = $(el);
            const coord = lib.extractCoord($el.find('a[href*="screen=report&mode=all&view="]').first().text());
            if (!coord) return;

            const dotImg = $el.find('img[src*="graphic/dots/"]').attr('src');
            const color = dotImg?.match(/dots\/(green|yellow|red|blue|red_blue)/)?.[1] || 'green';
            const maxLoot = $el.find('img[src*="max_loot/1"]').length > 0;

            data.farms.farms[coord] = {
              id: parseFloat($el.attr('id').split('_')[1]),
              color,
              max_loot: maxLoot,
            };
          });
          return data;
        };

        const fetchNewBarbs = () => {
          if (!options.newbarbs) return Promise.resolve(data);
          return twLib.get('/map/village.txt').then(response => {
            response.match(/[^\r\n]+/g).forEach(line => {
              const [id, name, x, y, player_id] = line.split(',');
              if (player_id === '0') {
                const coord = `${x}|${y}`;
                if (!data.farms.farms[coord]) {
                  data.farms.farms[coord] = { id: parseFloat(id) };
                }
              }
            });
            return data;
          });
        };

        const filterFarms = () => {
          data.farms.farms = Object.fromEntries(
            Object.entries(data.farms.farms).filter(([coord, val]) => {
              if (!val.hasOwnProperty('color')) return true; // new barb
              return val.color !== 'red' && val.color !== 'red_blue' && (val.color !== 'yellow' || options.losses);
            })
          );
          return data;
        };

        // Run all data fetches in parallel, then add new barbs, then filter
        return Promise.all([
          lib.processAllPages(TribalWars.buildURL('GET', 'overview_villages', { mode: 'combined', group: options.group }), villagesProcessor),
          lib.processAllPages(TribalWars.buildURL('GET', 'overview_villages', { mode: 'commands', type: 'attack' }), commandsProcessor),
          lib.processAllPages(TribalWars.buildURL('GET', 'am_farm'), farmProcessor),
        ]).then(() => fetchNewBarbs()).then(filterFarms).then(() => data);
      });
    };

    // ---------- Planning Algorithm (Optimized) ----------
    const createPlanning = function (options, data) {
      const plan = { counter: 0, farms: {} };
      const serverTime = Math.round(lib.getCurrentServerTime() / 1000);
      const maxDist = options.distance;
      const minInterval = options.time * 60;

      // Clear distance cache for fresh run
      lib.clearDistanceCache();

      for (const originCoord in data.villages) {
        const originVillage = data.villages[originCoord];
        let availableUnits = originVillage.units.slice();

        // Filter and sort targets
        const candidateTargets = Object.keys(data.farms.farms)
          .map(targetCoord => {
            // Bounding box pre-filter
            if (!lib.isWithinBoundingBox(originCoord, targetCoord, maxDist)) return null;
            const dist = lib.getDistance(originCoord, targetCoord);
            if (dist > maxDist) return null;
            return { coord: targetCoord, dist };
          })
          .filter(v => v !== null)
          .sort((a, b) => a.dist - b.dist);

        for (const target of candidateTargets) {
          const farmInfo = data.farms.farms[target.coord];
          const templateName = (options.maxloot && farmInfo.max_loot) ? 'b' : 'a';
          const template = data.farms.templates[templateName];
          if (!template) continue;

          // Check troop availability
          const unitsAfter = lib.subtractArrays(availableUnits, template.units);
          if (!unitsAfter) continue;

          // Calculate arrival time
          const travelTime = Math.round(target.dist * template.speed * 60);
          const candidateArrival = serverTime + travelTime + Math.round(plan.counter / 5);

          // Cooldown check using last arrival time only
          const lastArrival = data.commands[target.coord] || 0;
          if (Math.abs(candidateArrival - lastArrival) < minInterval) continue;

          // Schedule attack
          plan.counter++;
          if (!plan.farms[originCoord]) plan.farms[originCoord] = [];

          plan.farms[originCoord].push({
            origin: { coord: originCoord, name: originVillage.name, id: originVillage.id },
            target: { coord: target.coord, id: farmInfo.id },
            fields: target.dist,
            template: { name: templateName, id: template.id },
          });

          // Update state
          availableUnits = unitsAfter;
          data.commands[target.coord] = candidateArrival; // store new last arrival
        }
      }
      return plan;
    };

    // ---------- Send Farm ----------
    const sendFarm = function ($this) {
      const now = Timing.getElapsedTimeSinceLoad();
      if (farmBusy || (Accountmanager.farm.last_click && now - Accountmanager.farm.last_click < 200)) return;

      farmBusy = true;
      Accountmanager.farm.last_click = now;
      const $pb = $('#FarmGodProgessbar');

      const url = Accountmanager.send_units_link.replace(/village=(\d+)/, 'village=' + $this.data('origin'));
      TribalWars.post(url, null, {
        target: $this.data('target'),
        template_id: $this.data('template'),
        source: $this.data('origin'),
      }, response => {
        UI.SuccessMessage(response.success);
        $pb.data('current', $pb.data('current') + 1);
        UI.updateProgressBar($pb, $pb.data('current'), $pb.data('max'));
        $this.closest('.farmRow').remove();
        farmBusy = false;
      }, error => {
        UI.ErrorMessage(error || t.messages.sendError);
        $pb.data('current', $pb.data('current') + 1);
        UI.updateProgressBar($pb, $pb.data('current'), $pb.data('max'));
        $this.closest('.farmRow').remove();
        farmBusy = false;
      });
    };

    return { init };
  })(window.FarmGod.Library, window.FarmGod.Translation.get());

  // Auto-start
  window.FarmGod.Main.init();
})();

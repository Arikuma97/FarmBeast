// Hungarian translation provided by =Krumpli=
// Modified version — improvements by Claude (Anthropic)
//
// CLUSTER SIZING CHANGES (vs original):
//
//   Total troops = home troops + (outgoing attack count × template LKV)
//   No return-time prediction needed — we simply count attacks already in flight.
//
//   Cluster size = min(simultaneousCapacity, cyclingCapacity)
//
//     simultaneousCapacity = floor(totalLKV / templateLKV)
//       How many template-A farms can this village support in total
//       (both in the air and queued up).
//
//     cyclingCapacity = ceil(2 × maxDistance × lkvSpeed / optionTime)
//       How many distinct targets are needed so that by the time the last
//       farm in the rotation lands and returns, the first target is ready
//       to be hit again — permanent, gapless cycling.
//
//   Greedy nearest-first assignment: each barb goes to the nearest village
//   that still has remaining cluster capacity.  Each target is owned by
//   exactly one village.
//
// BUG FIXES (vs original):
//   [Fix 1] B→A template fallback — no longer skips a farm just because
//           there are not enough troops for B; tries A first.
//   [Fix 2] Real vs planned commands separated — nearby villages no longer
//           block each other through the wide optionTime window.
//   [Fix 3] New-barb hard lock removed — normal timing check applies.

ScriptAPI.register('FarmGod', true, 'Warre', 'nl.tribalwars@coma.innogames.de');

window.FarmGod = {};
window.FarmGod.Library = (function () {
  /**** TribalWarsLibrary.js ****/
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
            let item = this.dequeue();
            let self = this;

            if (item.action == 'openWindow') {
              window
                .open(...item.arguments)
                .addEventListener('DOMContentLoaded', function () {
                  self.start();
                });
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
            if (!this.working) {
              this.start();
            }
          };
        },
        createQueues: function (amount) {
          let arr = [];
          for (let i = 0; i < amount; i++) {
            arr[i] = new twLib.queueLib.Queue();
          }
          return arr;
        },
        addItem: function (item) {
          let leastBusyQueue = twLib.queues
            .map((q) => q.length)
            .reduce((next, curr) => (curr < next ? curr : next), 0);
          twLib.queues[leastBusyQueue].enqueue(item);
        },
        orchestrator: function (type, arg) {
          let promise = $.Deferred();
          let item = new twLib.queueLib.Item(type, arg, promise);
          twLib.queueLib.addItem(item);
          return promise;
        },
      },
      ajax: function () {
        return twLib.queueLib.orchestrator('ajax', arguments);
      },
      get: function () {
        return twLib.queueLib.orchestrator('get', arguments);
      },
      post: function () {
        return twLib.queueLib.orchestrator('post', arguments);
      },
      openWindow: function () {
        let item = new twLib.queueLib.Item('openWindow', arguments);
        twLib.queueLib.addItem(item);
      },
    };

    twLib.init();
  }

  /**** Script Library ****/
  const setUnitSpeeds = function () {
    let unitSpeeds = {};
    $.when($.get('/interface.php?func=get_unit_info')).then((xml) => {
      $(xml)
        .find('config')
        .children()
        .map((i, el) => {
          unitSpeeds[$(el).prop('nodeName')] = $(el).find('speed').text().toNumber();
        });
      localStorage.setItem('FarmGod_unitSpeeds', JSON.stringify(unitSpeeds));
    });
  };

  const getUnitSpeeds = function () {
    return JSON.parse(localStorage.getItem('FarmGod_unitSpeeds')) || false;
  };

  if (!getUnitSpeeds()) setUnitSpeeds();

  const determineNextPage = function (page, $html) {
    let villageLength =
      $html.find('#scavenge_mass_screen').length > 0
        ? $html.find('tr[id*="scavenge_village"]').length
        : $html.find('tr.row_a, tr.row_ax, tr.row_b, tr.row_bx').length;
    let navSelect = $html
      .find('.paged-nav-item')
      .first()
      .closest('td')
      .find('select')
      .first();
    let navLength =
      $html.find('#am_widget_Farm').length > 0
        ? parseInt(
            $('#plunder_list_nav')
              .first()
              .find('a.paged-nav-item, strong.paged-nav-item')[
                $('#plunder_list_nav')
                  .first()
                  .find('a.paged-nav-item, strong.paged-nav-item').length - 1
              ].textContent.replace(/\D/g, '')
          ) - 1
        : navSelect.length > 0
        ? navSelect.find('option').length - 1
        : $html.find('.paged-nav-item').not('[href*="page=-1"]').length;
    let pageSize =
      $('#mobileHeader').length > 0
        ? 10
        : parseInt($html.find('input[name="page_size"]').val());

    if (page == -1 && villageLength == 1000) {
      return Math.floor(1000 / pageSize);
    } else if (page < navLength) {
      return page + 1;
    }

    return false;
  };

  const processPage = function (url, page, wrapFn) {
    let pageText = url.match('am_farm') ? `&Farm_page=${page}` : `&page=${page}`;
    return twLib
      .ajax({ url: url + pageText })
      .then((html) => wrapFn(page, $(html)));
  };

  const processAllPages = function (url, processorFn) {
    let page = url.match('am_farm') || url.match('scavenge_mass') ? 0 : -1;
    let wrapFn = function (page, $html) {
      let dnp = determineNextPage(page, $html);
      if (dnp) {
        processorFn($html);
        return processPage(url, dnp, wrapFn);
      } else {
        return processorFn($html);
      }
    };
    return processPage(url, page, wrapFn);
  };

  const getDistance = function (origin, target) {
    let a = origin.toCoord(true).x - target.toCoord(true).x;
    let b = origin.toCoord(true).y - target.toCoord(true).y;
    return Math.hypot(a, b);
  };

  const subtractArrays = function (array1, array2) {
    let result = array1.map((val, i) => val - array2[i]);
    return result.some((v) => v < 0) ? false : result;
  };

  const getCurrentServerTime = function () {
    let [hour, min, sec, day, month, year] = $('#serverTime')
      .closest('p')
      .text()
      .match(/\d+/g);
    return new Date(year, month - 1, day, hour, min, sec).getTime();
  };

  const timestampFromString = function (timestr) {
    let d = $('#serverDate').text().split('/').map((x) => +x);
    let todayPattern = new RegExp(
      window.lang['aea2b0aa9ae1534226518faaefffdaad'].replace('%s', '([\\d+|:]+)')
    ).exec(timestr);
    let tomorrowPattern = new RegExp(
      window.lang['57d28d1b211fddbb7a499ead5bf23079'].replace('%s', '([\\d+|:]+)')
    ).exec(timestr);
    let laterDatePattern = new RegExp(
      window.lang['0cb274c906d622fa8ce524bcfbb7552d']
        .replace('%1', '([\\d+|\\.]+)')
        .replace('%2', '([\\d+|:]+)')
    ).exec(timestr);
    let t, date;

    if (todayPattern !== null) {
      t = todayPattern[1].split(':');
      date = new Date(d[2], d[1] - 1, d[0], t[0], t[1], t[2], t[3] || 0);
    } else if (tomorrowPattern !== null) {
      t = tomorrowPattern[1].split(':');
      date = new Date(d[2], d[1] - 1, d[0] + 1, t[0], t[1], t[2], t[3] || 0);
    } else {
      d = (laterDatePattern[1] + d[2]).split('.').map((x) => +x);
      t = laterDatePattern[2].split(':');
      date = new Date(d[2], d[1] - 1, d[0], t[0], t[1], t[2], t[3] || 0);
    }

    return date.getTime();
  };

  String.prototype.toCoord = function (objectified) {
    let c = (this.match(/\d{1,3}\|\d{1,3}/g) || [false]).pop();
    return c && objectified ? { x: c.split('|')[0], y: c.split('|')[1] } : c;
  };

  String.prototype.toNumber = function () {
    return parseFloat(this);
  };

  Number.prototype.toNumber = function () {
    return parseFloat(this);
  };

  return {
    getUnitSpeeds,
    processPage,
    processAllPages,
    getDistance,
    subtractArrays,
    getCurrentServerTime,
    timestampFromString,
  };
})();

window.FarmGod.Translation = (function () {
  const msg = {
    nl_NL: {
      missingFeatures: 'Script vereist een premium account en farm assistent!',
      options: {
        title: 'FarmGod Opties',
        warning:
          '<b>Waarschuwingen:</b><br>- Zorg dat A is ingesteld als je standaard microfarm en B als een grotere microfarm<br>- Zorg dat de farm filters correct zijn ingesteld voor je het script gebruikt',
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
    hu_HU: {
      missingFeatures: 'A scriptnek szÃ¼ksÃ©ge van PrÃ©mium fiÃ³kra Ã©s FarmkezelÅ're!',
      options: {
        title: 'FarmGod opciÃ³k',
        warning:
          '<b>Figyelem:</b><br>- Bizonyosodj meg rÃ³la, hogy az "A" sablon az alapÃ©rtelmezett Ã©s a "B" egy nagyobb mennyisÃ©gÅ± mikrÃ³-farm<br>- Bizonyosodj meg rÃ³la, hogy a farm-filterek megfelelÅ'en vannak beÃ¡llÃ­tva mielÅ'tt hasznÃ¡lod a sctiptet',
        filterImage: 'https://higamy.github.io/TW/Scripts/Assets/farmGodFilters_HU.png',
        group: 'EbbÅ'l a csoportbÃ³l kÃ¼ldje:',
        distance: 'MaximÃ¡lis mezÅ' tÃ¡volsÃ¡g:',
        time: 'Mekkora idÅ'intervallumban kÃ¼ldje a tÃ¡madÃ¡sokat percben:',
        losses: 'KÃ¼ldjÃ¶n tÃ¡madÃ¡st olyan falvakba ahol rÃ©szleges vesztesÃ©ggel jÃ¡rhat a tÃ¡madÃ¡s:',
        maxloot: 'A "B" sablont kÃ¼ldje abban az esetben, ha az elÅ'zÅ' tÃ¡madÃ¡s maximÃ¡lis fosztogatÃ¡ssal jÃ¡rt:',
        newbarbs: 'Adj hozzÃ¡ Ãºj barbÃ¡r falukat:',
        button: 'Farm megtervezÃ©se',
      },
      table: {
        noFarmsPlanned: 'A jelenlegi beÃ¡llÃ­tÃ¡sokkal nem lehet Ãºj tÃ¡madÃ¡st kikÃ¼ldeni.',
        origin: 'Origin',
        target: 'CÃ©lpont',
        fields: 'TÃ¡volsÃ¡g',
        farm: 'Farm',
        goTo: 'Go to',
      },
      messages: {
        villageChanged: 'Falu sikeresen megvÃ¡ltoztatva!',
        villageError: 'Minden farm kiment a jelenlegi falubÃ³l!',
        sendError: 'Hiba: Farm nemvolt elkÃ¼ldve!',
      },
    },
    int: {
      missingFeatures: 'Script requires a premium account and loot assistent!',
      options: {
        title: 'FarmGod Options',
        warning:
          '<b>Warning:</b><br>- Make sure A is set as your default microfarm and B as a larger microfarm<br>- Make sure the farm filters are set correctly before using the script',
        filterImage: 'https://higamy.github.io/TW/Scripts/Assets/farmGodFilters.png',
        group: 'Send farms from group:',
        distance: 'Maximum fields for farms:',
        time: 'How much time in minutes should there be between farms:',
        losses: 'Send farm to villages with partial losses:',
        maxloot: 'Send a B farm if the last loot was full:',
        newbarbs: 'Add new barbs to farm:',
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
    let lang = msg.hasOwnProperty(game_data.locale) ? game_data.locale : 'int';
    return msg[lang];
  };

  return { get };
})();

window.FarmGod.Main = (function (Library, Translation) {
  const lib = Library;
  const t = Translation.get();
  let curVillage = null;
  let farmBusy = false;

  const init = function () {
    if (
      game_data.features.Premium.active &&
      game_data.features.FarmAssistent.active
    ) {
      if (game_data.screen == 'am_farm') {
        $.when(buildOptions()).then((html) => {
          Dialog.show('FarmGod', html);

          $('.optionButton')
            .off('click')
            .on('click', () => {
              let optionGroup    = parseInt($('.optionGroup').val());
              let optionDistance = parseFloat($('.optionDistance').val());
              let optionTime     = parseFloat($('.optionTime').val());
              let optionLosses   = $('.optionLosses').prop('checked');
              let optionMaxloot  = $('.optionMaxloot').prop('checked');
              let optionNewbarbs = $('.optionNewbarbs').prop('checked') || false;

              localStorage.setItem(
                'farmGod_options',
                JSON.stringify({
                  optionGroup,
                  optionDistance,
                  optionTime,
                  optionLosses,
                  optionMaxloot,
                  optionNewbarbs,
                })
              );

              $('.optionsContent').html(UI.Throbber[0].outerHTML + '<br><br>');

              getData(optionGroup, optionNewbarbs, optionLosses).then((data) => {
                Dialog.close();

                let plan = createPlanning(
                  optionDistance,
                  optionTime,
                  optionMaxloot,
                  data
                );

                $('.farmGodContent').remove();
                $('#am_widget_Farm').first().before(buildTable(plan.farms));

                bindEventHandlers();
                UI.InitProgressBars();
                UI.updateProgressBar($('#FarmGodProgessbar'), 0, plan.counter);
                $('#FarmGodProgessbar')
                  .data('current', 0)
                  .data('max', plan.counter);
              });
            });

          document.querySelector('.optionButton').focus();
        });
      } else {
        location.href = game_data.link_base_pure + 'am_farm';
      }
    } else {
      UI.ErrorMessage(t.missingFeatures);
    }
  };

  const bindEventHandlers = function () {
    $('.farmGod_icon')
      .off('click')
      .on('click', function () {
        if (
          game_data.market != 'nl' ||
          $(this).data('origin') == curVillage
        ) {
          sendFarm($(this));
        } else {
          UI.ErrorMessage(t.messages.villageError);
        }
      });

    $(document)
      .off('keydown')
      .on('keydown', (event) => {
        if ((event.keyCode || event.which) == 13) {
          $('.farmGod_icon').first().trigger('click');
        }
      });

    $('.switchVillage')
      .off('click')
      .on('click', function () {
        curVillage = $(this).data('id');
        UI.SuccessMessage(t.messages.villageChanged);
        $(this).closest('tr').remove();
      });
  };

  const buildOptions = function () {
    let options = JSON.parse(localStorage.getItem('farmGod_options')) || {
      optionGroup: 0,
      optionDistance: 25,
      optionTime: 10,
      optionLosses: false,
      optionMaxloot: true,
      optionNewbarbs: true,
    };
    let checkboxSettings = [false, true, true, true, false];
    let checkboxError = $('#plunder_list_filters')
      .find('input[type="checkbox"]')
      .map((i, el) => $(el).prop('checked') != checkboxSettings[i])
      .get()
      .includes(true);
    let $templateRows = $('form[action*="action=edit_all"]')
      .find('input[type="hidden"][name*="template"]')
      .closest('tr');
    let templateError =
      $templateRows.first().find('td').last().text().toNumber() >=
      $templateRows.last().find('td').last().text().toNumber();

    return $.when(buildGroupSelect(options.optionGroup)).then((groupSelect) => {
      return `<style>#popup_box_FarmGod{text-align:center;width:550px;}</style>
              <h3>${t.options.title}</h3><br><div class="optionsContent">
              ${
                checkboxError || templateError
                  ? `<div class="info_box" style="line-height:15px;font-size:10px;text-align:left;"><p style="margin:0px 5px;">${t.options.warning}<br><img src="${t.options.filterImage}" style="width:100%;"></p></div><br>`
                  : ``
              }
              <div style="width:90%;margin:auto;background:url('graphic/index/main_bg.jpg') 100% 0% #E3D5B3;border:1px solid #7D510F;border-collapse:separate !important;border-spacing:0px !important;"><table class="vis" style="width:100%;text-align:left;font-size:11px;">
                <tr><td>${t.options.group}</td><td>${groupSelect}</td></tr>
                <tr><td>${t.options.distance}</td><td><input type="text" size="5" class="optionDistance" value="${options.optionDistance}"></td></tr>
                <tr><td>${t.options.time}</td><td><input type="text" size="5" class="optionTime" value="${options.optionTime}"></td></tr>
                <tr><td>${t.options.losses}</td><td><input type="checkbox" class="optionLosses" ${options.optionLosses ? 'checked' : ''}></td></tr>
                <tr><td>${t.options.maxloot}</td><td><input type="checkbox" class="optionMaxloot" ${options.optionMaxloot ? 'checked' : ''}></td></tr>
                ${
                  game_data.market == 'nl'
                    ? `<tr><td>${t.options.newbarbs}</td><td><input type="checkbox" class="optionNewbarbs" ${options.optionNewbarbs ? 'checked' : ''}></td></tr>`
                    : ''
                }
              </table></div><br><input type="button" class="btn optionButton" value="${t.options.button}"></div>`;
    });
  };

  const buildGroupSelect = function (id) {
    return $.get(
      TribalWars.buildURL('GET', 'groups', { ajax: 'load_group_menu' })
    ).then((groups) => {
      let html = `<select class="optionGroup">`;
      groups.result.forEach((val) => {
        if (val.type == 'separator') {
          html += `<option disabled=""/>`;
        } else {
          html += `<option value="${val.group_id}" ${
            val.group_id == id ? 'selected' : ''
          }>${val.name}</option>`;
        }
      });
      html += `</select>`;
      return html;
    });
  };

  const buildTable = function (plan) {
    let html = `<div class="vis farmGodContent"><h4>FarmGod</h4><table class="vis" width="100%">
                <tr><div id="FarmGodProgessbar" class="progress-bar live-progress-bar progress-bar-alive" style="width:98%;margin:5px auto;"><div style="background:rgb(146,194,0);"></div><span class="label" style="margin-top:0px;"></span></div></tr>
                <tr><th style="text-align:center;">${t.table.origin}</th><th style="text-align:center;">${t.table.target}</th><th style="text-align:center;">${t.table.fields}</th><th style="text-align:center;">${t.table.farm}</th></tr>`;

    if (!$.isEmptyObject(plan)) {
      for (let prop in plan) {
        if (game_data.market == 'nl') {
          html += `<tr><td colspan="4" style="background:#e7d098;"><input type="button" class="btn switchVillage" data-id="${plan[prop][0].origin.id}" value="${t.table.goTo} ${plan[prop][0].origin.name} (${plan[prop][0].origin.coord})" style="float:right;"></td></tr>`;
        }
        plan[prop].forEach((val, i) => {
          html += `<tr class="farmRow row_${i % 2 == 0 ? 'a' : 'b'}">
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

  const getData = function (group, newbarbs, losses) {
    let data = {
      villages:      {},
      commands:      {},  // real outgoing arrival timestamps, keyed by TARGET coord
      outgoingCount: {},  // number of attacks currently out, keyed by ORIGIN village coord
      farms:         { templates: {}, farms: {} },
    };

    // ─────────────────────────────────────────────────────────────────────
    // Village processor — unchanged from original
    // ─────────────────────────────────────────────────────────────────────
    let villagesProcessor = ($html) => {
      let skipUnits = ['ram', 'catapult', 'knight', 'snob', 'militia'];
      const mobileCheck = $('#mobileHeader').length > 0;

      if (mobileCheck) {
        let table = jQuery($html).find('.overview-container > div');
        table.each((i, el) => {
          try {
            const villageId = jQuery(el).find('.quickedit-vn').data('id');
            const name      = jQuery(el).find('.quickedit-label').attr('data-text');
            const coord     = jQuery(el).find('.quickedit-label').text().toCoord();
            const units     = new Array(game_data.units.length).fill(0);
            const unitsElements = jQuery(el).find('.overview-units-row > div.unit-row-item');

            unitsElements.each((_, unitElement) => {
              const img  = jQuery(unitElement).find('img');
              const span = jQuery(unitElement).find('span.unit-row-name');
              if (img.length && span.length) {
                let unitType = img
                  .attr('src')
                  .split('unit_')[1]
                  .replace('@2x.webp', '')
                  .replace('.webp', '')
                  .replace('.png', '');
                const value     = parseInt(span.text()) || 0;
                const unitIndex = game_data.units.indexOf(unitType);
                if (unitIndex !== -1) units[unitIndex] = value;
              }
            });

            const filteredUnits = units.filter(
              (_, index) => skipUnits.indexOf(game_data.units[index]) === -1
            );

            data.villages[coord] = { name, id: villageId, units: filteredUnits };
          } catch (e) {
            console.error('Error processing village data:', e);
          }
        });
      } else {
        $html
          .find('#combined_table')
          .find('.row_a, .row_b')
          .filter((i, el) => $(el).find('.bonus_icon_33').length == 0)
          .map((i, el) => {
            let $el  = $(el);
            let $qel = $el.find('.quickedit-label').first();
            let units = $el
              .find('.unit-item')
              .filter((index) => skipUnits.indexOf(game_data.units[index]) == -1)
              .map((index, element) => $(element).text().toNumber())
              .get();

            return (data.villages[$qel.text().toCoord()] = {
              name:  $qel.data('text'),
              id:    parseInt($el.find('.quickedit-vn').first().data('id')),
              units: units,
            });
          });
      }

      console.log('[FarmGod] villages loaded', data.villages);
      return data;
    };

    // ─────────────────────────────────────────────────────────────────────
    // Commands processor
    //
    // Two things are tracked per row:
    //   1. Arrival timestamp on the TARGET (for the timing check — unchanged)
    //   2. Outgoing attack count on the ORIGIN village (new)
    //      We count how many attacks are currently flying from each of our
    //      villages.  This is used in createPlanning to calculate total LKV
    //      (home + in-flight) without any return-time prediction.
    // ─────────────────────────────────────────────────────────────────────
    let commandsProcessor = ($html) => {
      $html
        .find('#commands_table')
        .find('.row_a, .row_ax, .row_b, .row_bx')
        .map((i, el) => {
          let $el        = $(el);
          let targetCoord = $el.find('.quickedit-label').first().text().toCoord();

          if (targetCoord) {
            // ── 1. Arrival timestamp on the target (for timing checks) ──
            if (!data.commands.hasOwnProperty(targetCoord))
              data.commands[targetCoord] = [];

            data.commands[targetCoord].push(
              Math.round(
                lib.timestampFromString($el.find('td').eq(2).text().trim()) / 1000
              )
            );

            // ── 2. Outgoing count on the origin village (for total troop calc) ──
            // The origin village coordinate is shown in the first <td> of the row.
            let originCoord = $el.find('td').eq(0).text().toCoord();
            if (originCoord && data.villages.hasOwnProperty(originCoord)) {
              data.outgoingCount[originCoord] =
                (data.outgoingCount[originCoord] || 0) + 1;
            }
          }
        });

      return data;
    };

    // ─────────────────────────────────────────────────────────────────────
    // Farm processor — unchanged from original
    // ─────────────────────────────────────────────────────────────────────
    let farmProcessor = ($html) => {
      if ($.isEmptyObject(data.farms.templates)) {
        let unitSpeeds = lib.getUnitSpeeds();

        $html
          .find('form[action*="action=edit_all"]')
          .find('input[type="hidden"][name*="template"]')
          .closest('tr')
          .map((i, el) => {
            let $el = $(el);
            return (data.farms.templates[
              $el
                .prev('tr')
                .find('a.farm_icon')
                .first()
                .attr('class')
                .match(/farm_icon_(.*)\s/)[1]
            ] = {
              id: $el
                .find('input[type="hidden"][name*="template"][name*="[id]"]')
                .first()
                .val()
                .toNumber(),
              units: $el
                .find('input[type="text"], input[type="number"]')
                .map((index, element) => $(element).val().toNumber())
                .get(),
              speed: Math.max(
                ...$el
                  .find('input[type="text"], input[type="number"]')
                  .map((index, element) => {
                    return $(element).val().toNumber() > 0
                      ? unitSpeeds[$(element).attr('name').trim().split('[')[0]]
                      : 0;
                  })
                  .get()
              ),
            });
          });
      }

      $html
        .find('#plunder_list')
        .find('tr[id^="village_"]')
        .map((i, el) => {
          let $el = $(el);
          return (data.farms.farms[
            $el
              .find('a[href*="screen=report&mode=all&view="]')
              .first()
              .text()
              .toCoord()
          ] = {
            id:       $el.attr('id').split('_')[1].toNumber(),
            color:    $el
              .find('img[src*="graphic/dots/"]')
              .attr('src')
              .match(/dots\/(green|yellow|red|blue|red_blue)/)[1],
            max_loot: $el.find('img[src*="max_loot/1"]').length > 0,
          });
        });

      return data;
    };

    // ─────────────────────────────────────────────────────────────────────
    // New barbs loader — unchanged from original
    // ─────────────────────────────────────────────────────────────────────
    let findNewbarbs = () => {
      if (newbarbs) {
        return twLib.get('/map/village.txt').then((allVillages) => {
          allVillages.match(/[^\r\n]+/g).forEach((villageData) => {
            let [id, name, x, y, player_id] = villageData.split(',');
            let coord = `${x}|${y}`;
            if (player_id == 0 && !data.farms.farms.hasOwnProperty(coord)) {
              data.farms.farms[coord] = { id: id.toNumber() };
            }
          });
          return data;
        });
      } else {
        return data;
      }
    };

    // ─────────────────────────────────────────────────────────────────────
    // Farm filter — unchanged from original
    // ─────────────────────────────────────────────────────────────────────
    let filterFarms = () => {
      data.farms.farms = Object.fromEntries(
        Object.entries(data.farms.farms).filter(([key, val]) => {
          return (
            !val.hasOwnProperty('color') ||
            (val.color != 'red' &&
              val.color != 'red_blue' &&
              (val.color != 'yellow' || losses))
          );
        })
      );
      return data;
    };

    return Promise.all([
      lib.processAllPages(
        TribalWars.buildURL('GET', 'overview_villages', { mode: 'combined', group }),
        villagesProcessor
      ),
      lib.processAllPages(
        TribalWars.buildURL('GET', 'overview_villages', { mode: 'commands', type: 'attack' }),
        commandsProcessor
      ),
      lib.processAllPages(
        TribalWars.buildURL('GET', 'am_farm'),
        farmProcessor
      ),
      findNewbarbs(),
    ])
      .then(filterFarms)
      .then(() => data);
  };

  // ─────────────────────────────────────────────────────────────────────────
  // createPlanning
  //
  // CLUSTER SIZING
  // ──────────────
  // The goal is permanent cycling: every time a farm returns, the next one
  // in the rotation is already due to go out (or has already been sent).
  //
  // Two constraints determine how many targets each village should own:
  //
  //   a) simultaneousCapacity — how many templates can this village field at once?
  //
  //        totalLKV  = homeLKV + (outgoingCount × templateLKV)
  //        simultaneous = floor(totalLKV / templateLKV)
  //
  //      homeLKV is what the game reports as home right now.
  //      outgoingCount is the number of attacks already in the air from this
  //      village (parsed from the commands overview).
  //      Multiplying by templateLKV gives the troops currently in transit.
  //      Together they represent the village's full LKV pool regardless of
  //      where those troops physically are right now.
  //
  //   b) cyclingCapacity — how many distinct targets needed for permanent cycling?
  //
  //        roundTripMinutes = 2 × optionDistance × lkvSpeed
  //        cyclingCapacity  = ceil(roundTripMinutes / optionTime)
  //
  //      Uses optionDistance (the configured max) as the worst-case distance.
  //      This guarantees the rotation never runs dry even at the edge of range.
  //
  //   clusterSize = min(a, b)
  //
  //   The binding constraint self-corrects on every run:
  //   - If troops come home, homeLKV rises → (a) grows → cluster can expand.
  //   - If troops go out,   homeLKV falls → (a) stays the same (outgoingCount
  //     compensates) → cluster stays stable.
  //   - If the player changes optionDistance or optionTime, (b) recalculates
  //     automatically.
  //
  // ASSIGNMENT
  // ──────────
  // 1. Build every (village, target) pair within optionDistance.
  // 2. Sort all pairs by distance (nearest first).
  // 3. Greedily assign: nearest unassigned target goes to the nearest village
  //    that still has remaining capacity.
  // 4. Each target ends up owned by exactly one village — no competition,
  //    no duplicate attacks.
  //
  // PLAN BUILDING
  // ─────────────
  // Within each village's cluster:
  //   - Sort targets nearest-first.
  //   - Apply a 2-second send stagger so arrivals don't land on the same tick.
  //   - Timing check against real commands (full optionTime window).   [Fix 2]
  //   - Timing check against planned commands (10-second window only). [Fix 2]
  //   - B→A template fallback before skipping a target.               [Fix 1]
  //   - New-barb hard lock removed.                                   [Fix 3]
  // ─────────────────────────────────────────────────────────────────────────
  const createPlanning = function (optionDistance, optionTime, optionMaxloot, data) {
    const plan        = { counter: 0, farms: {} };
    const serverTime  = Math.round(lib.getCurrentServerTime() / 1000);
    const maxTimeDiff = optionTime * 60; // minutes → seconds

    // Arrivals planned this session — only blocks within 10 seconds to prevent
    // exact same-tick arrivals without locking out nearby villages. [Fix 2]
    const plannedCommands = {};

    const unitSpeeds = lib.getUnitSpeeds();
    const lkvKey     = 'light'; // light cavalry
    const lkvSpeed   = unitSpeeds && unitSpeeds[lkvKey] ? unitSpeeds[lkvKey] : 0;
    const lkvIndex   = game_data.units.indexOf(lkvKey);

    // ── Cluster size per village ──────────────────────────────────────────
    const calculateClusterSize = (villageCoord) => {
      const templateA = data.farms.templates['a'];
      if (!templateA) return 0;

      const templateLkv = lkvIndex >= 0 ? (templateA.units[lkvIndex] || 0) : 0;

      // ── Constraint a: simultaneousCapacity ──
      //
      // Total LKV this village owns, regardless of where they are right now:
      //   home troops (reported by overview) +
      //   in-flight troops (outgoingCount × templateLKV per attack)
      //
      // This means: whether troops are at home or in the air doesn't matter.
      // The cluster size is stable across periodic runs.
      const homeLkv      = lkvIndex >= 0 ? (data.villages[villageCoord].units[lkvIndex] || 0) : 0;
      const outgoing     = data.outgoingCount[villageCoord] || 0;
      const inFlightLkv  = outgoing * templateLkv;
      const totalLkv     = homeLkv + inFlightLkv;

      let simultaneousCapacity;
      if (templateLkv > 0) {
        simultaneousCapacity = Math.floor(totalLkv / templateLkv);
      } else {
        // LKV not used in template A — fall back to exhaustive subtraction
        let units = [...data.villages[villageCoord].units];
        simultaneousCapacity = 0;
        let rem = lib.subtractArrays(units, templateA.units);
        while (rem) {
          simultaneousCapacity++;
          units = rem;
          rem = lib.subtractArrays(units, templateA.units);
        }
        // Add in-flight count on top (each outgoing attack freed up one template)
        simultaneousCapacity += outgoing;
      }

      // ── Constraint b: cyclingCapacity ──
      //
      // round trip at max distance (minutes) = 2 × optionDistance × lkvSpeed
      // cycling capacity = ceil(roundTrip / optionTime)
      //
      // Example:
      //   optionDistance = 20 fields, lkvSpeed = 10 min/field, optionTime = 10 min
      //   roundTrip = 2 × 20 × 10 = 400 min
      //   cyclingCapacity = ceil(400 / 10) = 40
      //
      //   That means: to keep attacks flying permanently at max distance with a
      //   10-minute gap between each, you need 40 distinct targets.
      //
      // Uses optionDistance as worst-case so the cycle never breaks at range edges.
      const roundTripMinutes = lkvSpeed > 0
        ? 2 * optionDistance * lkvSpeed
        : optionTime * 2; // safe fallback when lkvSpeed unavailable
      const cyclingCapacity  = Math.ceil(roundTripMinutes / optionTime);

      const clusterSize = Math.min(simultaneousCapacity, cyclingCapacity);

      console.log(
        `[FarmGod] ${villageCoord}`,
        `homeLKV:${homeLkv} inFlight:${inFlightLkv} (${outgoing} attacks)`,
        `total:${totalLkv} templateLKV:${templateLkv}`,
        `simultaneous:${simultaneousCapacity} cycling:${cyclingCapacity}`,
        `→ clusterSize:${clusterSize}`
      );

      return clusterSize;
    };

    // ── Capacity table ────────────────────────────────────────────────────
    const remainingCapacity = {};
    for (let coord in data.villages) {
      remainingCapacity[coord] = calculateClusterSize(coord);
    }

    // ── All valid pairs within distance, sorted nearest-first ─────────────
    const allTargetCoords = Object.keys(data.farms.farms);
    const pairs = [];

    for (let villageCoord in data.villages) {
      for (let targetCoord of allTargetCoords) {
        const dist = lib.getDistance(villageCoord, targetCoord);
        if (dist < optionDistance) {
          pairs.push({ village: villageCoord, target: targetCoord, dist });
        }
      }
    }

    pairs.sort((a, b) => a.dist - b.dist);

    // ── Greedy assignment ─────────────────────────────────────────────────
    const assignments     = {}; // targetCoord → villageCoord
    const assignedTargets = new Set();

    for (const pair of pairs) {
      if (
        !assignedTargets.has(pair.target) &&
        remainingCapacity[pair.village] > 0
      ) {
        assignments[pair.target]         = pair.village;
        remainingCapacity[pair.village] -= 1;
        assignedTargets.add(pair.target);
      }
    }

    // ── Invert: village → [targets] ───────────────────────────────────────
    const villageClusters = {};
    for (let targetCoord in assignments) {
      const v = assignments[targetCoord];
      if (!villageClusters[v]) villageClusters[v] = [];
      villageClusters[v].push(targetCoord);
    }

    // ── Build plan ────────────────────────────────────────────────────────
    for (let villageCoord in villageClusters) {
      const village = data.villages[villageCoord];

      // Sort cluster nearest-first
      const targets = villageClusters[villageCoord]
        .map((coord) => ({
          coord,
          dist: lib.getDistance(villageCoord, coord),
        }))
        .sort((a, b) => a.dist - b.dist);

      // Local unit copy — don't mutate shared data
      let units = [...village.units];

      for (let i = 0; i < targets.length; i++) {
        const target   = targets[i];
        const farmData = data.farms.farms[target.coord];
        if (!farmData) continue;

        // [Fix 1] Try B first; fall back to A if not enough home troops
        let template_name = optionMaxloot && farmData.max_loot ? 'b' : 'a';
        let template      = data.farms.templates[template_name];
        let unitsLeft     = lib.subtractArrays(units, template.units);

        if (!unitsLeft && template_name === 'b') {
          template_name = 'a';
          template      = data.farms.templates['a'];
          unitsLeft     = lib.subtractArrays(units, template.units);
        }

        // No home troops left for even template A — stop this village's cluster
        if (!unitsLeft) break;

        // 2-second stagger: spreads arrivals within the cluster
        const travelTime = Math.round(target.dist * template.speed * 60);
        const arrival    = serverTime + travelTime + (i * 2);

        // [Fix 2] Real commands: full optionTime window
        const realConflict = (data.commands[target.coord] || []).some(
          (ts) => Math.abs(ts - arrival) < maxTimeDiff
        );

        // [Fix 2] Planned this session: 10-second window only
        // Prevents same-tick arrivals without blocking nearby villages
        const plannedConflict = (plannedCommands[target.coord] || []).some(
          (ts) => Math.abs(ts - arrival) < 10
        );

        // [Fix 3] No special new-barb lock — same rules for everyone
        if (realConflict || plannedConflict) continue;

        // ── Commit ──
        plan.counter++;
        if (!plan.farms[villageCoord]) plan.farms[villageCoord] = [];

        plan.farms[villageCoord].push({
          origin:   { coord: villageCoord, name: village.name, id: village.id },
          target:   { coord: target.coord, id: farmData.id },
          fields:   target.dist,
          template: { name: template_name, id: template.id },
        });

        units = unitsLeft;

        if (!plannedCommands[target.coord]) plannedCommands[target.coord] = [];
        plannedCommands[target.coord].push(arrival);
      }
    }

    console.log(`[FarmGod] Planning complete — ${plan.counter} farms scheduled.`);
    return plan;
  };

  const sendFarm = function ($this) {
    let n = Timing.getElapsedTimeSinceLoad();
    if (
      !farmBusy &&
      !(Accountmanager.farm.last_click && n - Accountmanager.farm.last_click < 200)
    ) {
      farmBusy = true;
      Accountmanager.farm.last_click = n;
      let $pb = $('#FarmGodProgessbar');

      TribalWars.post(
        Accountmanager.send_units_link.replace(
          /village=(\d+)/,
          'village=' + $this.data('origin')
        ),
        null,
        {
          target:      $this.data('target'),
          template_id: $this.data('template'),
          source:      $this.data('origin'),
        },
        function (r) {
          UI.SuccessMessage(r.success);
          $pb.data('current', $pb.data('current') + 1);
          UI.updateProgressBar($pb, $pb.data('current'), $pb.data('max'));
          $this.closest('.farmRow').remove();
          farmBusy = false;
        },
        function (r) {
          UI.ErrorMessage(r || t.messages.sendError);
          $pb.data('current', $pb.data('current') + 1);
          UI.updateProgressBar($pb, $pb.data('current'), $pb.data('max'));
          $this.closest('.farmRow').remove();
          farmBusy = false;
        }
      );
    }
  };

  return { init };
})(window.FarmGod.Library, window.FarmGod.Translation);

(() => {
  window.FarmGod.Main.init();
})();

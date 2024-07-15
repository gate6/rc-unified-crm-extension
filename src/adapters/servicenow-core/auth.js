// const {UserModel1} = require('../models/userModel');
const Sequelize = require('sequelize');
const { sequelize } = require('../servicenow-models/sequelize');
const initModels = require('../servicenow-models/init-models');
const models = initModels(sequelize);
const Op = require('sequelize').Op;


async function saveUserInfo(userObj,accessToken){
    try {
        // console.log(userObj);
        let id = userObj.id;
        console.log("userObj",userObj);
        console.log("id",id);
        const existingUser = await models.customer.findOne({
            where: {
                [Op.and]: [
                    {
                        id,
                        // platform
                    }
                ]
            }
        });
        if (existingUser) {
            console.log('Existing user update');
            // const updateUser = await UserModel1.update({

            // })
        }
        else {
            console.log('This is userobj',userObj);
            const createUser = await models.customer.create({
                sysId: userObj.id, 
                firstName: userObj.first_name, 
                lastName: userObj.last_name,
                email: userObj.email,
                companyId: 1,
                accessToken:accessToken,
                hostname:process.env.SERVICE_NOW_HOSTNAME
            })
            console.log(createUser);
        }    
    } catch (error) {
        console.log(error);
        return error
    }
}

exports.saveUserInfo = saveUserInfo;